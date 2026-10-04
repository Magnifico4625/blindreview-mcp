import type { Config } from "../src/config.js";
import type { ReviewerProvider } from "../src/providers/provider.js";
import { Reviewer } from "../src/reviewer/reviewer.js";
import { ReviewError, type AnyMode, type ReviewResult, type Verdict } from "../src/schemas/review.js";
import { toReviewInput, type BenchmarkCase } from "./cases.js";
import { evaluateRun, summarize, type ModeSummary, type RunEvaluation, type RunOutcome } from "./evaluator.js";
import { fmtRate, fmtSpread, rng, shuffle } from "./stats.js";

export const DEFAULT_MODES: readonly AnyMode[] = ["proposal_first", "proposal_first_2pass", "blind_first"];

export interface BenchmarkOptions {
  modes?: readonly AnyMode[];
  runs?: number;
  seed?: number;
  /** Number of (case, run) units executed in parallel. Modes inside a unit run sequentially. */
  concurrency?: number;
  log?: (msg: string) => void;
}

export interface CaseRun {
  run: number;
  mode_order: AnyMode[];
  results: Partial<Record<AnyMode, { outcome: RunOutcome; evaluation: RunEvaluation }>>;
}

export interface BenchmarkReport {
  created_at: string;
  model: string;
  base_url_host: string;
  budget: {
    max_tokens_per_call: number;
    max_review_tokens: number;
    timeout_ms: number;
    reasoning_effort: string | null;
    temperature: number | null;
  };
  modes: AnyMode[];
  runs: number;
  seed: number;
  cases: Array<{
    id: string;
    title: string;
    has_hidden_flaw: boolean;
    expected_verdict: Verdict;
    acceptable_verdicts: Verdict[];
    runs: CaseRun[];
  }>;
  summary: ModeSummary[];
}

/**
 * Same model, same budget, same config for every mode; each review gets a fresh Reviewer.
 * Mode order is shuffled per (case, run) with a seeded PRNG so order effects average out
 * and runs are reproducible.
 */
export async function runBenchmark(
  cases: BenchmarkCase[],
  config: Config,
  provider: ReviewerProvider,
  options: BenchmarkOptions = {},
): Promise<BenchmarkReport> {
  const modes = [...(options.modes ?? DEFAULT_MODES)];
  const runs = Math.max(1, options.runs ?? 3);
  const seed = options.seed ?? 42;
  const log = options.log ?? (() => {});
  const random = rng(seed);

  const report: BenchmarkReport = {
    created_at: new Date().toISOString(),
    model: provider.model,
    base_url_host: safeHost(config.baseUrl),
    budget: {
      max_tokens_per_call: config.maxTokensPerCall,
      max_review_tokens: config.maxReviewTokens,
      timeout_ms: config.timeoutMs,
      reasoning_effort: config.reasoningEffort ?? null,
      temperature: config.temperature ?? null,
    },
    modes,
    runs,
    seed,
    cases: cases.map((c) => ({
      id: c.id,
      title: c.title,
      has_hidden_flaw: c.has_hidden_flaw,
      expected_verdict: c.expected_verdict,
      acceptable_verdicts: c.acceptable_verdicts,
      runs: [],
    })),
    summary: [],
  };

  // Build all units up front (deterministic order + shuffles), then execute with a small pool.
  const units: Array<{ ci: number; run: number; order: AnyMode[] }> = [];
  for (let run = 1; run <= runs; run++) {
    for (let ci = 0; ci < cases.length; ci++) units.push({ ci, run, order: shuffle(modes, random) });
  }

  const reviewOne = async (c: BenchmarkCase, mode: AnyMode): Promise<RunOutcome> => {
    const reviewer = new Reviewer({
      provider,
      maxTokensPerCall: config.maxTokensPerCall,
      maxReviewTokens: config.maxReviewTokens,
      timeoutMs: config.timeoutMs,
      blindnessLeakThreshold: config.blindnessLeakThreshold,
      blindnessWarnThreshold: config.blindnessWarnThreshold,
    });
    const started = performance.now();
    try {
      const opts = mode === "proposal_first_2pass" ? { benchmarkMode: mode } : {};
      return { ok: true, result: await reviewer.review(toReviewInput(c, mode), opts) };
    } catch (err) {
      const code = err instanceof ReviewError ? err.code : "INTERNAL_ERROR";
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { code, message }, latency_ms: Math.round(performance.now() - started) };
    }
  };

  let next = 0;
  const worker = async () => {
    while (next < units.length) {
      const unit = units[next++] as (typeof units)[number];
      const c = cases[unit.ci] as BenchmarkCase;
      const caseRun: CaseRun = { run: unit.run, mode_order: unit.order, results: {} };
      for (const mode of unit.order) {
        const outcome = await reviewOne(c, mode);
        const evaluation = evaluateRun(c, outcome);
        caseRun.results[mode] = { outcome, evaluation };
        log(
          `${c.id} run${unit.run} [${mode}] ${
            evaluation.ok
              ? `${evaluation.verdict} (expected ${c.expected_verdict}) conf=${evaluation.confidence} tokens=${evaluation.total_tokens} ${evaluation.latency_ms}ms`
              : `ERROR ${evaluation.error_code}`
          }`,
        );
      }
      (report.cases[unit.ci] as BenchmarkReport["cases"][number]).runs.push(caseRun);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 1) }, worker));
  for (const entry of report.cases) entry.runs.sort((a, b) => a.run - b.run);

  report.summary = modes.map((mode) =>
    summarize(
      mode,
      report.cases.flatMap((entry, ci) =>
        entry.runs.map((r) => {
          const res = r.results[mode] as { outcome: RunOutcome; evaluation: RunEvaluation };
          const result: ReviewResult | undefined = res.outcome.ok ? res.outcome.result : undefined;
          return { c: cases[ci] as BenchmarkCase, e: res.evaluation, ...(result ? { result } : {}) };
        }),
      ),
    ),
  );
  return report;
}

export function toMarkdown(report: BenchmarkReport, cost?: { usd: number; note: string }): string {
  const b = report.budget;
  const lines: string[] = [
    `# BlindReview benchmark ${report.created_at}`,
    "",
    `Model \`${report.model}\` via ${report.base_url_host}; ${report.runs} run(s) per case and mode, seed ${report.seed}, mode order shuffled per case/run.`,
    `Budget per review: ${b.max_review_tokens} tokens (${b.max_tokens_per_call} per call), timeout ${b.timeout_ms} ms, reasoning_effort=${b.reasoning_effort ?? "unset"}, temperature=${b.temperature ?? "provider default"}.`,
    ...(cost ? [`Estimated cost: $${cost.usd.toFixed(4)} (${cost.note}).`] : []),
    "",
    "Mechanical stats only, no LLM judge. Rates show k/n, % and 95% Wilson CI. Definitions: see benchmark/evaluator.ts.",
    "",
    "## Summary per mode",
    "",
    "| mode | errors | flawed: exact | flawed: acceptable | flawed: under / over / abstain | sound: exact KEEP | sound: acceptable | sound: false alarm (REPLACE) | tokens/review (mean ± sd) | latency ms (mean ± sd) | kw ratio (weak) |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const s of report.summary) {
    lines.push(
      `| ${s.mode} | ${s.errors}/${s.runs} | ${fmtRate(s.flawed.exact)} | ${fmtRate(s.flawed.acceptable)} | ${s.flawed.under} / ${s.flawed.over} / ${s.flawed.abstain} | ${fmtRate(s.sound.exact_keep)} | ${fmtRate(s.sound.acceptable)} | ${fmtRate(s.sound.false_alarm)} | ${fmtSpread(s.total_tokens)} | ${fmtSpread(s.latency_ms)} | ${s.flawed.kw_ratio_weak.mean ?? "-"} |`,
    );
  }
  lines.push("", "## Verdicts per case (all runs)", "", `| case | flaw? | expected (acceptable) | ${report.modes.join(" | ")} |`, `|---|---|---|${report.modes.map(() => "---").join("|")}|`);
  for (const c of report.cases) {
    const cells = report.modes.map((m) => {
      const tally: Record<string, number> = {};
      for (const r of c.runs) {
        const e = r.results[m]?.evaluation;
        const key = !e ? "-" : e.ok ? (e.verdict as string) : `ERR:${e.error_code}`;
        tally[key] = (tally[key] ?? 0) + 1;
      }
      return Object.entries(tally)
        .map(([k, n]) => `${k}×${n}`)
        .join(" ");
    });
    lines.push(`| ${c.id} | ${c.has_hidden_flaw ? "yes" : "no"} | ${c.expected_verdict} (${c.acceptable_verdicts.join("/")}) | ${cells.join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

export function safeHost(url: string): string {
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
