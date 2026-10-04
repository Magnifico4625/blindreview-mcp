import type { AnyMode, ReviewResult, Verdict } from "../src/schemas/review.js";
import type { BenchmarkCase } from "./cases.js";
import { spread, wilson, type Rate, type Spread } from "./stats.js";

/**
 * Mechanical statistics only. There is NO LLM judge and no winner is declared.
 *
 * Definitions (per run):
 *  - exact:       verdict === case.expected_verdict
 *  - acceptable:  verdict in case.acceptable_verdicts
 *  - severity:    KEEP=0 < MODIFY=1 < REPLACE=2; INSUFFICIENT_EVIDENCE is an "abstain" (no severity)
 *  - under:       severity below every acceptable verdict  (e.g. KEEP on a flawed case)
 *  - over:        severity above every acceptable verdict  (e.g. REPLACE on a sound case)
 *  - false alarm: REPLACE on a sound control case (has_hidden_flaw=false)
 *  - kw (WEAK heuristic): share of hidden_flaw_keywords regex groups found in the returned text.
 *    It only shows the topic was mentioned, not that the flaw was understood.
 */
export type RunOutcome =
  | { ok: true; result: ReviewResult }
  | { ok: false; error: { code: string; message: string }; latency_ms: number };

export interface RunEvaluation {
  ok: boolean;
  verdict: Verdict | null;
  exact: boolean | null;
  acceptable: boolean | null;
  under: boolean | null;
  over: boolean | null;
  abstain: boolean | null;
  false_alarm: boolean | null;
  confidence: number | null;
  total_tokens: number | null;
  latency_ms: number;
  kw_ratio: number | null;
  error_code?: string;
}

export const SEVERITY: Record<Exclude<Verdict, "INSUFFICIENT_EVIDENCE">, number> = { KEEP: 0, MODIFY: 1, REPLACE: 2 };

export function reviewText(result: ReviewResult): string {
  return [
    result.recommendation,
    ...result.critical_assumptions,
    ...result.material_risks,
    result.better_alternative ?? "",
    result.falsification_probe.description,
    result.falsification_probe.expected_signal,
  ].join("\n");
}

export function keywordGroupsHit(text: string, groups: readonly string[]): string[] {
  return groups.filter((g) => {
    try {
      return new RegExp(g, "i").test(text);
    } catch {
      return text.toLowerCase().includes(g.toLowerCase());
    }
  });
}

export function evaluateRun(c: BenchmarkCase, run: RunOutcome): RunEvaluation {
  if (!run.ok) {
    return {
      ok: false,
      verdict: null,
      exact: null,
      acceptable: null,
      under: null,
      over: null,
      abstain: null,
      false_alarm: null,
      confidence: null,
      total_tokens: null,
      latency_ms: run.latency_ms,
      kw_ratio: null,
      error_code: run.error.code,
    };
  }
  const r = run.result;
  const v = r.verdict;
  const ranks = c.acceptable_verdicts.filter((a) => a !== "INSUFFICIENT_EVIDENCE").map((a) => SEVERITY[a]);
  const abstain = v === "INSUFFICIENT_EVIDENCE";
  const sev = abstain ? null : SEVERITY[v];
  const hits = keywordGroupsHit(reviewText(r), c.hidden_flaw_keywords);
  return {
    ok: true,
    verdict: v,
    exact: v === c.expected_verdict,
    acceptable: c.acceptable_verdicts.includes(v),
    under: sev !== null && ranks.length > 0 && sev < Math.min(...ranks),
    over: sev !== null && ranks.length > 0 && sev > Math.max(...ranks),
    abstain,
    false_alarm: !c.has_hidden_flaw && v === "REPLACE",
    confidence: r.confidence,
    total_tokens: r.meta.usage.total_tokens,
    latency_ms: r.meta.latency_ms,
    kw_ratio: c.hidden_flaw_keywords.length ? hits.length / c.hidden_flaw_keywords.length : null,
  };
}

export interface ModeSummary {
  mode: AnyMode;
  runs: number;
  errors: number;
  verdicts: Record<Verdict, number>;
  flawed: { exact: Rate; acceptable: Rate; under: number; over: number; abstain: number; kw_ratio_weak: Spread };
  sound: { exact_keep: Rate; acceptable: Rate; false_alarm: Rate; over: number; abstain: number };
  confidence: Spread;
  total_tokens: Spread;
  latency_ms: Spread;
  tokens_sum: { prompt: number; completion: number; total: number };
}

export function summarize(mode: AnyMode, rows: Array<{ c: BenchmarkCase; e: RunEvaluation; result?: ReviewResult }>): ModeSummary {
  const ok = rows.filter((r) => r.e.ok);
  const verdicts: Record<Verdict, number> = { KEEP: 0, MODIFY: 0, REPLACE: 0, INSUFFICIENT_EVIDENCE: 0 };
  for (const r of ok) if (r.e.verdict) verdicts[r.e.verdict]++;
  const flawed = ok.filter((r) => r.c.has_hidden_flaw);
  const sound = ok.filter((r) => !r.c.has_hidden_flaw);
  const count = (xs: typeof ok, f: (e: RunEvaluation) => boolean | null) => xs.filter((r) => f(r.e) === true).length;
  const tokens_sum = { prompt: 0, completion: 0, total: 0 };
  for (const r of ok) {
    if (!r.result) continue;
    tokens_sum.prompt += r.result.meta.usage.prompt_tokens;
    tokens_sum.completion += r.result.meta.usage.completion_tokens;
    tokens_sum.total += r.result.meta.usage.total_tokens;
  }
  return {
    mode,
    runs: rows.length,
    errors: rows.length - ok.length,
    verdicts,
    flawed: {
      exact: wilson(count(flawed, (e) => e.exact), flawed.length),
      acceptable: wilson(count(flawed, (e) => e.acceptable), flawed.length),
      under: count(flawed, (e) => e.under),
      over: count(flawed, (e) => e.over),
      abstain: count(flawed, (e) => e.abstain),
      kw_ratio_weak: spread(flawed.map((r) => r.e.kw_ratio ?? 0)),
    },
    sound: {
      exact_keep: wilson(count(sound, (e) => e.exact), sound.length),
      acceptable: wilson(count(sound, (e) => e.acceptable), sound.length),
      false_alarm: wilson(count(sound, (e) => e.false_alarm), sound.length),
      over: count(sound, (e) => e.over),
      abstain: count(sound, (e) => e.abstain),
    },
    confidence: spread(ok.map((r) => r.e.confidence ?? 0)),
    total_tokens: spread(ok.map((r) => r.e.total_tokens ?? 0)),
    latency_ms: spread(ok.map((r) => r.e.latency_ms)),
    tokens_sum,
  };
}
