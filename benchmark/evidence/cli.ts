import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../../src/config.js";
import { OpenAIToolProvider } from "../../src/evidence/tool-provider.js";
import { OpenAICompatibleProvider } from "../../src/providers/openai-compatible.js";
import { fileTimestamp } from "../runner.js";
import { DEFAULT_REPO_CASES_DIR, loadRepoCases } from "./cases.js";
import { fetchOpenRouterPricing, SpendLedger, type Pricing } from "./cost.js";
import { repoMarkdown } from "./report.js";
import { BudgetStop, REPO_MODES, runRepoBenchmark, type RepoMode, type RepoRunRecord } from "./runner.js";

const USAGE = `Usage: npm run benchmark:evidence -- --model <id> [options] [repoCasesDir]

  --model <id>              reviewer model (required; REVIEWER_BASE_URL / REVIEWER_API_KEY from env)
  --modes <list>            ${REPO_MODES.join(",")} (default evidence_gate,decision_judge)
  --runs <n>                runs per case and mode (default 1)
  --only <ids>              comma-separated case ids
  --label <name>            output folder name (default: model id)
  --out <dir>               results root (default benchmark-results/v0.4)
  --ledger <file>           cumulative spend ledger (default <out>/spend.jsonl)
  --hard-stop-usd <x>       stop starting reviews when ledger spend + reserve exceeds x (default 0.95)
  --max-tool-calls <n>      evidence_gate tool-call cap per review (default 8)
  --max-review-tokens <n>   evidence_gate token cap per review (default 80000)
  --text-max-review-tokens <n> / --text-max-tokens-per-call <n>  baselines (default 24000 / 6000)
  --concurrency <n>         parallel reviews (default 3)
  --retries <n>             retries for transient errors (default 2)
  --seed <n>                default 42
  --resume                  reuse records from <out>/<label>/checkpoint.jsonl
`;

function int(name: string, v: unknown, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

async function main(): Promise<void> {
  const names = ["model", "modes", "runs", "only", "label", "out", "ledger", "hard-stop-usd", "max-tool-calls", "max-review-tokens", "text-max-review-tokens", "text-max-tokens-per-call", "concurrency", "retries", "seed"];
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { ...Object.fromEntries(names.map((n) => [n, { type: "string" as const }])), resume: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  const v = values as Record<string, string | boolean | undefined>;
  if (v.help || !v.model) {
    console.log(USAGE);
    if (!v.help) process.exit(1);
    return;
  }
  loadDotEnv();
  process.env.REVIEWER_MODEL = String(v.model);
  process.env.REVIEWER_MAX_TOKENS = String(int("--text-max-tokens-per-call", v["text-max-tokens-per-call"], 6000));
  process.env.MAX_REVIEW_TOKENS = String(int("--text-max-review-tokens", v["text-max-review-tokens"], 24000));
  const config = loadConfig();
  const modes = String(v.modes ?? "evidence_gate,decision_judge").split(",").map((s) => s.trim()) as RepoMode[];
  for (const m of modes) if (!(REPO_MODES as readonly string[]).includes(m)) throw new Error(`unknown mode ${m}`);
  const loaded = await loadRepoCases(path.resolve(positionals[0] ?? DEFAULT_REPO_CASES_DIR));
  let cases = loaded.cases;
  if (typeof v.only === "string") {
    const ids = new Set(v.only.split(","));
    cases = cases.filter((c) => ids.has(c.id));
  }
  if (!cases.length) throw new Error("no cases selected");
  const label = String(v.label ?? config.model.replace(/[^A-Za-z0-9._-]+/g, "_"));
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error("--label may only contain letters, digits, '.', '_' and '-'");
  const outRoot = path.resolve(String(v.out ?? path.join("benchmark-results", "v0.4")));
  const outDir = path.join(outRoot, label);
  await mkdir(outDir, { recursive: true });
  const ledger = new SpendLedger(path.resolve(String(v.ledger ?? path.join(outRoot, "spend.jsonl"))));
  const spentBefore = await ledger.load();
  const hardStop = Number(v["hard-stop-usd"] ?? 0.95);
  if (!Number.isFinite(hardStop) || hardStop <= 0) throw new Error("--hard-stop-usd must be a positive number");

  let pricing: Pricing;
  if (/openrouter\.ai/i.test(config.baseUrl)) pricing = await fetchOpenRouterPricing(config.model);
  else throw new Error("v0.4 runner needs OpenRouter pricing (REVIEWER_BASE_URL must be openrouter.ai)");
  const maxToolCalls = int("--max-tool-calls", v["max-tool-calls"], 8);
  const maxReviewTokens = int("--max-review-tokens", v["max-review-tokens"], 80_000);
  const reserve = {
    evidence_gate: maxReviewTokens * Math.max(pricing.prompt, pricing.completion) * 0.5,
    decision_judge: config.maxReviewTokens * Math.max(pricing.prompt, pricing.completion) * 0.5,
    proposal_first: config.maxReviewTokens * Math.max(pricing.prompt, pricing.completion) * 0.5,
  };
  const subset = cases.length !== loaded.cases.length ? `-subset${cases.length}` : "";
  const header = { type: "header", model: config.model, base_url: config.baseUrl, case_set_hash: loaded.hash + subset, max_tool_calls: maxToolCalls, max_review_tokens: maxReviewTokens, text_max_review_tokens: config.maxReviewTokens, text_max_tokens_per_call: config.maxTokensPerCall, reasoning_effort: config.reasoningEffort ?? null, temperature: config.temperature ?? null };
  const checkpoint = path.join(outDir, "checkpoint.jsonl");
  let resumeRecords: RepoRunRecord[] = [];
  if (v.resume) {
    const lines = (await readFile(checkpoint, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    if (lines.length) {
      if (JSON.stringify(lines[0]) !== JSON.stringify(header)) throw new Error(`--resume: ${checkpoint} was written with a different model/config/case set`);
      resumeRecords = lines.slice(1) as unknown as RepoRunRecord[];
    } else await writeFile(checkpoint, `${JSON.stringify(header)}\n`, "utf8");
  } else await writeFile(checkpoint, `${JSON.stringify(header)}\n`, "utf8");

  const runs = Math.max(1, int("--runs", v.runs, 1));
  const concurrency = Math.max(1, int("--concurrency", v.concurrency, 3));
  console.log(`[${label}] ${cases.length} cases x ${modes.join(",")} x ${runs} run(s), model ${config.model}; ledger spend so far $${spentBefore.toFixed(4)}, hard stop $${hardStop}`);
  try {
    const report = await runRepoBenchmark(cases, config, {
      label,
      model: config.model,
      modes,
      runs,
      seed: int("--seed", v.seed, 42),
      concurrency,
      retries: int("--retries", v.retries, 2),
      caseSetHash: header.case_set_hash,
      pricing,
      ledger,
      hardStopUsd: hardStop,
      reservePerReviewUsd: reserve,
      evidenceLimits: { maxToolCalls, maxReviewTokens },
      providers: {
        tool: () => new OpenAIToolProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, temperature: config.temperature, reasoningEffort: config.reasoningEffort }),
        text: (meter) =>
          new OpenAICompatibleProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, reasoningEffort: config.reasoningEffort, reasoningParam: config.reasoningParam, temperature: config.temperature, fetchImpl: meter.wrap() }),
      },
      resumeRecords,
      onRecord: (r) => appendFile(checkpoint, `${JSON.stringify(r)}\n`, "utf8"),
      log: (m) => console.log(m),
    });
    const base = path.join(outDir, fileTimestamp(new Date(report.created_at)));
    await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const md = repoMarkdown(report, cases);
    await writeFile(`${base}.md`, md, "utf8");
    console.log(`\n${md}`);
    console.log(`Saved ${base}.{json,md}. Ledger spend: before $${spentBefore.toFixed(4)}, now $${ledger.spent.toFixed(4)}`);
  } catch (err) {
    if (err instanceof BudgetStop) console.log(`Ledger spend: before $${spentBefore.toFixed(4)}, now $${ledger.spent.toFixed(4)}`);
    throw err;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
