import type { DiffCI } from "./stats.js";

/**
 * PRE-REGISTERED decision rules (written and committed BEFORE the v0.3.0 runs; do not tune
 * after seeing results). Applied to Δ = metric(A) − metric(B), where a positive Δ means "A better",
 * with the 95% paired case-bootstrap CI [lo, hi]:
 *
 *   clear signal          Δ ≥ +0.10 and lo > 0
 *   weak signal           Δ ≥ +0.05 and lo > −0.05        (and not "clear signal")
 *   no observed advantage Δ ≤ 0
 *   inconclusive          anything else (0 < Δ < 0.05, or Δ ≥ 0.05 with lo ≤ −0.05)
 *
 * Primary metric for Q1–Q3: decision accuracy with failures counted as wrong
 *   (verdict ∈ acceptable_verdicts; a failed review counts as not acceptable).
 * Primary metric for Q4: reduction of intervention rate on correct proposals
 *   (Δ = intervention(proposal_first) − intervention(decision_judge), intervention = MODIFY or REPLACE,
 *   failures excluded). Guard: if defect detection on flawed proposals drops by more than 0.10,
 *   the label gets the suffix " (with defect-detection loss)".
 */
export const THRESHOLDS = { clear: 0.1, weak: 0.05, weakLowerBound: -0.05 } as const;

export type SignalLabel = "clear signal" | "weak signal" | "inconclusive" | "no observed advantage";

export function signalLabel(d: DiffCI): SignalLabel {
  if (d.diff === null || d.ci95 === null) return "inconclusive";
  const [lo] = d.ci95;
  if (d.diff >= THRESHOLDS.clear && lo > 0) return "clear signal";
  if (d.diff >= THRESHOLDS.weak && lo > THRESHOLDS.weakLowerBound) return "weak signal";
  if (d.diff <= 0) return "no observed advantage";
  return "inconclusive";
}

export const DEFECT_LOSS_GUARD = 0.1;
