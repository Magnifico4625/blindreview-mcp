import type { AnyMode, ReviewResult, Usage, Verdict } from "../src/schemas/review.js";
import { isFlawed, primaryVerdict, PROPOSAL_STATUSES, type BenchmarkCase, type ProposalStatus } from "./cases.js";
import { mean, median, pairedBootstrapDiff, round, wilson, type DiffCI, type Rate } from "./stats.js";
import { DEFECT_LOSS_GUARD, signalLabel, type SignalLabel } from "./thresholds.js";

/**
 * Mechanical metrics only. No LLM judge, no winner declaration.
 *
 * Per run (successful):
 *   decision correct   verdict ∈ ground_truth.acceptable_verdicts
 *   exact              verdict === acceptable_verdicts[0] (primary / strictest expected)
 *   KEEP accuracy      correct proposals answered KEEP
 *   defect detection   flawed (materially|fundamentally) answered MODIFY or REPLACE
 *   false intervention correct answered MODIFY;  severe false intervention: correct answered REPLACE
 *   IE rate            INSUFFICIENT_EVIDENCE among successful runs
 * "strict" variants count every failed review (after retries) as a wrong answer, so failures never
 * shrink the denominator. Rates of undesirable outcomes (false intervention, IE) are over
 * successful runs only; their denominators are shown.
 * Keyword ratio = DIAGNOSTIC ONLY (topic mentioned, not flaw understood).
 */
export interface RunRecord {
  case_id: string;
  run: number;
  mode: AnyMode;
  attempts: number;
  retries: Array<{ code: string; message: string }>;
  ok: boolean;
  result?: ReviewResult;
  error?: { code: string; message: string; status?: number };
  /** Tokens of the final attempt (successful or not) plus all retried attempts. */
  usage_all_attempts: Usage;
  latency_ms: number;
}

export interface ModeMetrics {
  mode: AnyMode;
  expected: number;
  successful: number;
  failed: number;
  failure_reasons: Record<string, number>;
  retried_runs: number;
  decision_accuracy: Rate;
  decision_accuracy_strict: Rate;
  keep_accuracy_correct: Rate;
  keep_accuracy_correct_strict: Rate;
  defect_detection: Rate;
  defect_detection_strict: Rate;
  exact: Rate;
  exact_strict: Rate;
  false_intervention: Rate;
  severe_false_intervention: Rate;
  intervention_on_correct: Rate;
  insufficient_evidence: Rate;
  verdicts: Record<Verdict, number>;
  by_status: Partial<Record<ProposalStatus, { runs: number; successful: number; decision_accuracy: Rate; verdicts: Record<Verdict, number> }>>;
  tokens: { mean: number | null; median: number | null };
  latency_ms: { mean: number | null; median: number | null };
  tokens_all_attempts: Usage;
  keyword_ratio_diagnostic: number | null;
}

const emptyVerdicts = (): Record<Verdict, number> => ({ KEEP: 0, MODIFY: 0, REPLACE: 0, INSUFFICIENT_EVIDENCE: 0 });

export function reviewText(r: ReviewResult): string {
  return [r.recommendation, ...r.critical_assumptions, ...r.material_risks, r.better_alternative ?? "", r.falsification_probe.description, r.falsification_probe.expected_signal].join("\n");
}

function keywordRatio(c: BenchmarkCase, r: ReviewResult): number | null {
  const groups = c.diagnostics.hidden_flaw_keywords ?? [];
  if (!groups.length) return null;
  const text = reviewText(r);
  const hits = groups.filter((g) => {
    try {
      return new RegExp(g, "i").test(text);
    } catch {
      return text.toLowerCase().includes(g.toLowerCase());
    }
  });
  return hits.length / groups.length;
}

export function computeModeMetrics(mode: AnyMode, cases: BenchmarkCase[], records: RunRecord[]): ModeMetrics {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const rows = records.filter((r) => r.mode === mode).map((r) => ({ r, c: byId.get(r.case_id) as BenchmarkCase }));
  const ok = rows.filter((x) => x.r.ok && x.r.result);
  const v = (x: (typeof rows)[number]) => x.r.result?.verdict as Verdict;
  const rate = (sel: typeof rows, pred: (x: (typeof rows)[number]) => boolean) => wilson(sel.filter(pred).length, sel.length);
  const correct = rows.filter((x) => x.c.ground_truth.proposal_status === "correct");
  const flawed = rows.filter((x) => isFlawed(x.c));
  const okCorrect = correct.filter((x) => x.r.ok);
  const okFlawed = flawed.filter((x) => x.r.ok);
  const accepted = (x: (typeof rows)[number]) => x.r.ok && x.c.ground_truth.acceptable_verdicts.includes(v(x));
  const exact = (x: (typeof rows)[number]) => x.r.ok && v(x) === primaryVerdict(x.c);
  const keep = (x: (typeof rows)[number]) => x.r.ok && v(x) === "KEEP";
  const detect = (x: (typeof rows)[number]) => x.r.ok && (v(x) === "MODIFY" || v(x) === "REPLACE");

  const failure_reasons: Record<string, number> = {};
  for (const x of rows) if (!x.r.ok) failure_reasons[x.r.error?.code ?? "UNKNOWN"] = (failure_reasons[x.r.error?.code ?? "UNKNOWN"] ?? 0) + 1;
  const verdicts = emptyVerdicts();
  for (const x of ok) verdicts[v(x)]++;
  const by_status: ModeMetrics["by_status"] = {};
  for (const st of PROPOSAL_STATUSES) {
    const sel = rows.filter((x) => x.c.ground_truth.proposal_status === st);
    if (!sel.length) continue;
    const vv = emptyVerdicts();
    for (const x of sel) if (x.r.ok) vv[v(x)]++;
    by_status[st] = { runs: sel.length, successful: sel.filter((x) => x.r.ok).length, decision_accuracy: rate(sel.filter((x) => x.r.ok), accepted), verdicts: vv };
  }
  const tokens = ok.map((x) => (x.r.result as ReviewResult).meta.usage.total_tokens);
  const lat = ok.map((x) => x.r.latency_ms);
  const all: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const x of rows) {
    all.prompt_tokens += x.r.usage_all_attempts.prompt_tokens;
    all.completion_tokens += x.r.usage_all_attempts.completion_tokens;
    all.total_tokens += x.r.usage_all_attempts.total_tokens;
  }
  const kw = okFlawed.map((x) => keywordRatio(x.c, x.r.result as ReviewResult)).filter((n): n is number => n !== null);
  const m = (xs: number[]) => (xs.length ? round(mean(xs) as number, 1) : null);
  return {
    mode,
    expected: rows.length,
    successful: ok.length,
    failed: rows.length - ok.length,
    failure_reasons,
    retried_runs: rows.filter((x) => x.r.retries.length > 0).length,
    decision_accuracy: rate(ok, accepted),
    decision_accuracy_strict: rate(rows, accepted),
    keep_accuracy_correct: rate(okCorrect, keep),
    keep_accuracy_correct_strict: rate(correct, keep),
    defect_detection: rate(okFlawed, detect),
    defect_detection_strict: rate(flawed, detect),
    exact: rate(ok, exact),
    exact_strict: rate(rows, exact),
    false_intervention: rate(okCorrect, (x) => v(x) === "MODIFY"),
    severe_false_intervention: rate(okCorrect, (x) => v(x) === "REPLACE"),
    intervention_on_correct: rate(okCorrect, (x) => v(x) === "MODIFY" || v(x) === "REPLACE"),
    insufficient_evidence: rate(ok, (x) => v(x) === "INSUFFICIENT_EVIDENCE"),
    verdicts,
    by_status,
    tokens: { mean: m(tokens), median: median(tokens) },
    latency_ms: { mean: m(lat), median: median(lat) },
    tokens_all_attempts: all,
    keyword_ratio_diagnostic: kw.length ? round(mean(kw) as number) : null,
  };
}

/** Per-case 0/1 outcome lists for paired comparisons. */
function perCase(
  mode: AnyMode,
  cases: BenchmarkCase[],
  records: RunRecord[],
  include: (c: BenchmarkCase) => boolean,
  outcome: (c: BenchmarkCase, r: RunRecord) => 0 | 1 | null,
): Array<Array<0 | 1>> {
  return cases.filter(include).map((c) =>
    records
      .filter((r) => r.mode === mode && r.case_id === c.id)
      .map((r) => outcome(c, r))
      .filter((x): x is 0 | 1 => x !== null),
  );
}

const strictAccepted = (c: BenchmarkCase, r: RunRecord): 0 | 1 => (r.ok && r.result && c.ground_truth.acceptable_verdicts.includes(r.result.verdict) ? 1 : 0);
const detected = (_c: BenchmarkCase, r: RunRecord): 0 | 1 | null => (!r.ok || !r.result ? null : r.result.verdict === "MODIFY" || r.result.verdict === "REPLACE" ? 1 : 0);
const kept = (_c: BenchmarkCase, r: RunRecord): 0 | 1 | null => (!r.ok || !r.result ? null : r.result.verdict === "KEEP" ? 1 : 0);
const intervened = (_c: BenchmarkCase, r: RunRecord): 0 | 1 | null =>
  !r.ok || !r.result ? null : r.result.verdict === "MODIFY" || r.result.verdict === "REPLACE" ? 1 : 0;

export interface Comparison {
  question: string;
  a: AnyMode;
  b: AnyMode;
  primary_metric: string;
  primary: DiffCI;
  label: SignalLabel | `${SignalLabel} (with defect-detection loss)`;
  secondary: Record<string, DiffCI>;
}

export function compareModes(question: string, a: AnyMode, b: AnyMode, cases: BenchmarkCase[], records: RunRecord[], seed: number): Comparison {
  const all = () => true;
  const isCorrect = (c: BenchmarkCase) => c.ground_truth.proposal_status === "correct";
  const primary = pairedBootstrapDiff(perCase(a, cases, records, all, strictAccepted), perCase(b, cases, records, all, strictAccepted), { seed });
  return {
    question,
    a,
    b,
    primary_metric: "decision accuracy (strict: failures = wrong), Δ = A − B",
    primary,
    label: signalLabel(primary),
    secondary: {
      "defect detection on flawed (successful), Δ = A − B": pairedBootstrapDiff(perCase(a, cases, records, isFlawed, detected), perCase(b, cases, records, isFlawed, detected), { seed }),
      "KEEP accuracy on correct (successful), Δ = A − B": pairedBootstrapDiff(perCase(a, cases, records, isCorrect, kept), perCase(b, cases, records, isCorrect, kept), { seed }),
    },
  };
}

/** Q4: does decision_judge (A) reduce critic bias relative to proposal_first (B)? */
export function compareCriticBias(question: string, a: AnyMode, b: AnyMode, cases: BenchmarkCase[], records: RunRecord[], seed: number): Comparison {
  const isCorrect = (c: BenchmarkCase) => c.ground_truth.proposal_status === "correct";
  // Δ = intervention(B) − intervention(A): positive = A intervenes less on correct proposals.
  const primary = pairedBootstrapDiff(perCase(b, cases, records, isCorrect, intervened), perCase(a, cases, records, isCorrect, intervened), { seed });
  const defect = pairedBootstrapDiff(perCase(a, cases, records, isFlawed, detected), perCase(b, cases, records, isFlawed, detected), { seed });
  let label: Comparison["label"] = signalLabel(primary);
  if (defect.diff !== null && defect.diff < -DEFECT_LOSS_GUARD) label = `${label} (with defect-detection loss)`;
  return {
    question,
    a,
    b,
    primary_metric: "reduction of intervention rate (MODIFY/REPLACE) on correct proposals, Δ = B − A",
    primary,
    label,
    secondary: {
      "defect detection on flawed (successful), Δ = A − B": defect,
      "decision accuracy (strict), Δ = A − B": pairedBootstrapDiff(perCase(a, cases, records, () => true, strictAccepted), perCase(b, cases, records, () => true, strictAccepted), { seed }),
    },
  };
}
