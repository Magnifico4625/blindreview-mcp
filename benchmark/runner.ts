import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { loadConfig, loadDotEnv, type Config } from "../src/config.js";
import { buildProvider } from "../src/create-server.js";
import type { ReviewerProvider } from "../src/providers/provider.js";
import { Reviewer } from "../src/reviewer/reviewer.js";
import { REVIEW_MODES, ReviewError, type ReviewMode } from "../src/schemas/review.js";
import { loadCases, toReviewInput, type BenchmarkCase } from "./cases.js";
import { evaluateRun, summarize, type ModeSummary, type RunEvaluation, type RunOutcome } from "./evaluator.js";

export interface BenchmarkReport {
  created_at: string;
  model: string;
  base_url_host: string;
  budget: { max_tokens_per_call: number; max_review_tokens: number; timeout_ms: number; reasoning_effort: string | null };
  modes: ReviewMode[];
  cases: Array<{
    id: string;
    title: string;
    has_hidden_flaw: boolean;
    hidden_flaw_keywords: string[];
    runs: Partial<Record<ReviewMode, { outcome: RunOutcome; evaluation: RunEvaluation }>>;
  }>;
  summary: ModeSummary[];
}

/** Same model, same budget for every mode: each run gets a fresh Reviewer built from one config. */
export async function runBenchmark(
  cases: BenchmarkCase[],
  config: Config,
  provider: ReviewerProvider,
  modes: readonly ReviewMode[] = ["proposal_first", "blind_first"],
  log: (msg: string) => void = () => {},
): Promise<BenchmarkReport> {
  const report: BenchmarkReport = {
    created_at: new Date().toISOString(),
    model: provider.model,
    base_url_host: safeHost(config.baseUrl),
    budget: {
      max_tokens_per_call: config.maxTokensPerCall,
      max_review_tokens: config.maxReviewTokens,
      timeout_ms: config.timeoutMs,
      reasoning_effort: config.reasoningEffort ?? null,
    },
    modes: [...modes],
    cases: [],
    summary: [],
  };
  for (const c of cases) {
    const entry: BenchmarkReport["cases"][number] = {
      id: c.id,
      title: c.title,
      has_hidden_flaw: c.has_hidden_flaw,
      hidden_flaw_keywords: c.hidden_flaw_keywords,
      runs: {},
    };
    for (const mode of modes) {
      const reviewer = new Reviewer({
        provider,
        maxTokensPerCall: config.maxTokensPerCall,
        maxReviewTokens: config.maxReviewTokens,
        maxToolCalls: config.maxToolCalls,
        timeoutMs: config.timeoutMs,
      });
      const started = performance.now();
      let outcome: RunOutcome;
      try {
        outcome = { ok: true, result: await reviewer.review(toReviewInput(c, mode)) };
      } catch (err) {
        const code = err instanceof ReviewError ? err.code : "INTERNAL_ERROR";
        const message = err instanceof Error ? err.message : String(err);
        outcome = { ok: false, error: { code, message }, latency_ms: Math.round(performance.now() - started) };
      }
      const evaluation = evaluateRun(c, outcome);
      entry.runs[mode] = { outcome, evaluation };
      log(
        `${c.id} [${mode}] ${evaluation.ok ? `${evaluation.verdict} conf=${evaluation.confidence} tokens=${evaluation.total_tokens} ${evaluation.latency_ms}ms kw=${evaluation.keyword_groups_hit.length}/${c.hidden_flaw_keywords.length}` : `ERROR ${evaluation.error_code}`}`,
      );
    }
    report.cases.push(entry);
  }
  report.summary = modes.map((mode) =>
    summarize(
      mode,
      report.cases.map((entry) => {
        const c = cases.find((x) => x.id === entry.id) as BenchmarkCase;
        return { c, e: (entry.runs[mode] as { evaluation: RunEvaluation }).evaluation };
      }),
    ),
  );
  return report;
}

export function toMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [
    `# BlindReview benchmark ${report.created_at}`,
    "",
    `Model: \`${report.model}\` via ${report.base_url_host}. Budget: ${report.budget.max_review_tokens} tokens/review, ${report.budget.max_tokens_per_call} per call, reasoning_effort=${report.budget.reasoning_effort ?? "unset"}.`,
    "",
    "Mechanical stats only (no LLM judge). `kw` = hidden-flaw keyword groups found in the returned review (heuristic).",
    "",
    `| case | flaw? | ${report.modes.map((m) => `${m} verdict | conf | tokens | ms | kw`).join(" | ")} |`,
    `|---|---|${report.modes.map(() => "---|---|---|---|---").join("|")}|`,
  ];
  for (const c of report.cases) {
    const cells = report.modes.map((m) => {
      const e = c.runs[m]?.evaluation;
      if (!e) return "- | - | - | - | -";
      if (!e.ok) return `ERROR ${e.error_code} | - | - | ${e.latency_ms} | -`;
      return `${e.verdict} | ${e.confidence} | ${e.total_tokens} | ${e.latency_ms} | ${e.keyword_groups_hit.length}/${c.hidden_flaw_keywords.length}`;
    });
    lines.push(`| ${c.id} | ${c.has_hidden_flaw ? "yes" : "no"} | ${cells.join(" | ")} |`);
  }
  lines.push("", "## Summary", "", "| mode | runs | errors | flawed flagged (MODIFY/REPLACE) | avg kw hit ratio (flawed) | sound kept | avg conf | avg tokens | total tokens | avg ms |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const s of report.summary) {
    lines.push(
      `| ${s.mode} | ${s.runs} | ${s.errors} | ${s.flawed_flagged}/${s.flawed_cases} | ${s.avg_keyword_hit_ratio_flawed ?? "-"} | ${s.sound_kept}/${s.sound_cases} | ${s.avg_confidence ?? "-"} | ${s.avg_total_tokens ?? "-"} | ${s.total_tokens} | ${s.avg_latency_ms ?? "-"} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

/** Windows-safe timestamp for file names (no ':' characters). */
export function fileTimestamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", default: "benchmark-results" },
      modes: { type: "string", default: "proposal_first,blind_first" },
      only: { type: "string" },
    },
  });
  const dir = path.resolve(positionals[0] ?? path.join("examples", "cases"));
  const modes = values.modes.split(",").map((m) => m.trim()) as ReviewMode[];
  for (const m of modes) if (!REVIEW_MODES.includes(m)) throw new Error(`Unknown mode ${m}`);

  loadDotEnv();
  const config = loadConfig();
  let cases = await loadCases(dir);
  if (values.only) {
    const ids = new Set(values.only.split(","));
    cases = cases.filter((c) => ids.has(c.id));
  }
  if (!cases.length) throw new Error(`No cases found in ${dir}`);
  console.log(`Running ${cases.length} case(s) x ${modes.join(", ")} with ${config.model} @ ${safeHost(config.baseUrl)}`);

  const report = await runBenchmark(cases, config, buildProvider(config), modes, (m) => console.log(m));
  const outDir = path.resolve(values.out);
  await mkdir(outDir, { recursive: true });
  const base = path.join(outDir, fileTimestamp(new Date(report.created_at)));
  await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(`${base}.md`, toMarkdown(report), "utf8");
  console.log(`\n${toMarkdown(report)}`);
  console.log(`Saved ${base}.json and ${base}.md`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
