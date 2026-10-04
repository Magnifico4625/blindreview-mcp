import type { ReviewMode, ReviewResult, Verdict } from "../src/schemas/review.js";
import type { BenchmarkCase } from "./cases.js";

/**
 * Mechanical statistics only. There is NO LLM judge and no "winner" is declared.
 * Keyword hits are a crude heuristic: each entry in hidden_flaw_keywords is a group of
 * alternatives separated by "|" (regex syntax); a group hits if any alternative appears
 * (case-insensitive) in the reviewer's returned text.
 */
export type RunOutcome = { ok: true; result: ReviewResult } | { ok: false; error: { code: string; message: string }; latency_ms: number };

export interface RunEvaluation {
  ok: boolean;
  verdict: Verdict | null;
  flagged: boolean | null;
  confidence: number | null;
  total_tokens: number | null;
  latency_ms: number;
  keyword_groups_hit: string[];
  keyword_hit_ratio: number | null;
  error_code?: string;
}

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
      flagged: null,
      confidence: null,
      total_tokens: null,
      latency_ms: run.latency_ms,
      keyword_groups_hit: [],
      keyword_hit_ratio: null,
      error_code: run.error.code,
    };
  }
  const r = run.result;
  const hits = keywordGroupsHit(reviewText(r), c.hidden_flaw_keywords);
  return {
    ok: true,
    verdict: r.verdict,
    flagged: r.verdict === "MODIFY" || r.verdict === "REPLACE",
    confidence: r.confidence,
    total_tokens: r.meta.usage.total_tokens,
    latency_ms: r.meta.latency_ms,
    keyword_groups_hit: hits,
    keyword_hit_ratio: c.hidden_flaw_keywords.length ? hits.length / c.hidden_flaw_keywords.length : null,
  };
}

export interface ModeSummary {
  mode: ReviewMode;
  runs: number;
  errors: number;
  verdicts: Record<Verdict, number>;
  avg_confidence: number | null;
  avg_total_tokens: number | null;
  total_tokens: number;
  avg_latency_ms: number | null;
  flawed_cases: number;
  flawed_flagged: number;
  avg_keyword_hit_ratio_flawed: number | null;
  sound_cases: number;
  sound_kept: number;
}

const avg = (xs: number[]): number | null => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null);

export function summarize(mode: ReviewMode, rows: Array<{ c: BenchmarkCase; e: RunEvaluation }>): ModeSummary {
  const ok = rows.filter((r) => r.e.ok);
  const verdicts: Record<Verdict, number> = { KEEP: 0, MODIFY: 0, REPLACE: 0, INSUFFICIENT_EVIDENCE: 0 };
  for (const r of ok) if (r.e.verdict) verdicts[r.e.verdict]++;
  const flawed = ok.filter((r) => r.c.has_hidden_flaw);
  const sound = ok.filter((r) => !r.c.has_hidden_flaw);
  return {
    mode,
    runs: rows.length,
    errors: rows.length - ok.length,
    verdicts,
    avg_confidence: avg(ok.map((r) => r.e.confidence ?? 0)),
    avg_total_tokens: avg(ok.map((r) => r.e.total_tokens ?? 0)),
    total_tokens: ok.reduce((s, r) => s + (r.e.total_tokens ?? 0), 0),
    avg_latency_ms: avg(ok.map((r) => r.e.latency_ms)),
    flawed_cases: flawed.length,
    flawed_flagged: flawed.filter((r) => r.e.flagged).length,
    avg_keyword_hit_ratio_flawed: avg(flawed.map((r) => r.e.keyword_hit_ratio ?? 0)),
    sound_cases: sound.length,
    sound_kept: sound.filter((r) => r.e.verdict === "KEEP").length,
  };
}
