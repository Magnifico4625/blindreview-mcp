import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../src/config.js";
import { buildProvider } from "../src/create-server.js";
import { ALL_MODES, type AnyMode } from "../src/schemas/review.js";
import { DEFAULT_CASES_DIR, loadCases } from "./cases.js";
import { exportSheet } from "./human-review.js";
import { toExperimentMarkdown, toMarkdown } from "./report.js";
import type { RunRecord } from "./metrics.js";
import { DEFAULT_MODES, fileTimestamp, RateLimitStop, runBenchmark } from "./runner.js";
import { ThrottledProvider } from "./throttle.js";

const USAGE = `Usage: npm run benchmark -- [casesDir] [options]   (default casesDir: ${DEFAULT_CASES_DIR})
  --label NAME              results go to <out>/<label>/ (required for clarity; default: model id)
  --runs N                  runs per case and mode (default: BENCHMARK_RUNS or 3)
  --modes a,b               default ${DEFAULT_MODES.join(",")}
  --only id,id              only these case ids
  --seed N                  mode-order shuffle + bootstrap seed (default 42)
  --concurrency N           parallel (case, run) units (default: BENCHMARK_CONCURRENCY or 2)
  --retries N               retries per review on transient errors (default 2)
  --out DIR                 default benchmark-results
  --max-rpm N               at most N provider requests per minute (default: BENCHMARK_MAX_RPM or unlimited)
  --stop-on-rate-limit      stop (resumable) instead of recording failures when HTTP 429 persists after retries
  --resume                  reuse finished records from <out>/<label>/checkpoint.jsonl (same model/config/cases)
                            (every finished record is always appended to that checkpoint file)
  Provider config (override env): --base-url --model --reasoning-effort --reasoning-param
  --temperature --max-tokens --max-review-tokens --timeout`;

/** CLI flag -> env var; flags win over .env and the environment. */
const FLAG_ENV: Record<string, string> = {
  "base-url": "REVIEWER_BASE_URL",
  model: "REVIEWER_MODEL",
  "reasoning-effort": "REVIEWER_REASONING_EFFORT",
  "reasoning-param": "REVIEWER_REASONING_PARAM",
  temperature: "REVIEWER_TEMPERATURE",
  "max-tokens": "REVIEWER_MAX_TOKENS",
  "max-review-tokens": "MAX_REVIEW_TOKENS",
  timeout: "REVIEW_TIMEOUT",
};

function int(name: string, v: string | undefined, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(v)}`);
  return n;
}

async function main(): Promise<void> {
  const options = Object.fromEntries(
    ["label", "runs", "modes", "only", "seed", "concurrency", "retries", "out", "max-rpm", ...Object.keys(FLAG_ENV)].map((k) => [k, { type: "string" as const }]),
  );
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { ...options, help: { type: "boolean", short: "h" }, resume: { type: "boolean" }, "stop-on-rate-limit": { type: "boolean" } },
  });
  const v = values as Record<string, string | boolean | undefined>;
  if (v.help) {
    console.log(USAGE);
    return;
  }
  loadDotEnv();
  for (const [flag, env] of Object.entries(FLAG_ENV)) if (typeof v[flag] === "string") process.env[env] = v[flag] as string;
  const config = loadConfig();

  const modes = String(v.modes ?? DEFAULT_MODES.join(",")).split(",").map((m) => m.trim()) as AnyMode[];
  for (const m of modes) if (!(ALL_MODES as readonly string[]).includes(m)) throw new Error(`Unknown mode ${m}`);
  const dir = path.resolve(positionals[0] ?? DEFAULT_CASES_DIR);
  const loaded = await loadCases(dir);
  let cases = loaded.cases;
  if (typeof v.only === "string") {
    const ids = new Set(v.only.split(","));
    cases = cases.filter((c) => ids.has(c.id));
  }
  if (!cases.length) throw new Error(`No cases found in ${dir}`);
  const runs = Math.max(1, int("--runs", v.runs as string | undefined, int("BENCHMARK_RUNS", process.env.BENCHMARK_RUNS, 3)));
  const concurrency = Math.max(1, int("--concurrency", v.concurrency as string | undefined, int("BENCHMARK_CONCURRENCY", process.env.BENCHMARK_CONCURRENCY, 2)));
  const label = String(v.label ?? config.model.replace(/[^A-Za-z0-9._-]+/g, "_"));
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error("--label may only contain letters, digits, '.', '_' and '-'");

  const outDir = path.join(path.resolve(String(v.out ?? "benchmark-results")), label);
  await mkdir(outDir, { recursive: true });
  const checkpoint = path.join(outDir, "checkpoint.jsonl");
  const caseSetHash = loaded.hash + (cases.length !== loaded.cases.length ? `-subset${cases.length}` : "");
  const header = {
    type: "header",
    model: config.model,
    base_url: config.baseUrl,
    reasoning_effort: config.reasoningEffort ?? null,
    temperature: config.temperature ?? null,
    max_tokens_per_call: config.maxTokensPerCall,
    max_review_tokens: config.maxReviewTokens,
    case_set_hash: caseSetHash,
  };
  let resumeRecords: RunRecord[] = [];
  if (v.resume) {
    const lines = (await readFile(checkpoint, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    if (lines.length) {
      if (JSON.stringify(lines[0]) !== JSON.stringify(header)) throw new Error(`--resume: ${checkpoint} was written with a different model/config/case set`);
      resumeRecords = lines.slice(1) as unknown as RunRecord[];
    }
  } else {
    await writeFile(checkpoint, `${JSON.stringify(header)}\n`, "utf8");
  }
  if (v.resume && !resumeRecords.length) await writeFile(checkpoint, `${JSON.stringify(header)}\n`, "utf8");

  console.log(`[${label}] ${cases.length} cases x ${modes.join(", ")} x ${runs} runs, model ${config.model}, concurrency ${concurrency}`);
  const throttled = new ThrottledProvider(buildProvider(config), int("--max-rpm", v["max-rpm"] as string | undefined, int("BENCHMARK_MAX_RPM", process.env.BENCHMARK_MAX_RPM, 0)));
  const report = await runBenchmark(cases, config, {
    label,
    modes,
    runs,
    seed: int("--seed", v.seed as string | undefined, 42),
    concurrency,
    retries: int("--retries", v.retries as string | undefined, 2),
    caseSetHash,
    provider: throttled,
    stopOnRateLimit: Boolean(v["stop-on-rate-limit"]),
    log: (m) => console.log(m),
    resumeRecords,
    onRecord: (r) => appendFile(checkpoint, `${JSON.stringify(r)}\n`, "utf8"),
  }).catch((err: unknown) => {
    if (err instanceof RateLimitStop) console.log(`provider requests this session: ${throttled.calls}`);
    throw err;
  });
  console.log(`provider requests this session: ${throttled.calls}`);
  const base = path.join(outDir, fileTimestamp(new Date(report.created_at)));
  await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(`${base}.md`, toMarkdown(report), "utf8");
  await writeFile(`${base}.decision_judge.md`, toExperimentMarkdown(report), "utf8");
  const sheet = exportSheet(label, cases, report.records);
  await writeFile(`${base}.review-sheet.csv`, sheet.csv, "utf8");
  await writeFile(`${base}.sheet-key.json`, `${JSON.stringify(sheet.key, null, 2)}\n`, "utf8");
  console.log(`\n${toMarkdown(report)}`);
  console.log(`Saved ${base}.{json,md,decision_judge.md,review-sheet.csv,sheet-key.json}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
