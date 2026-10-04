import type { Rate } from "../stats.js";

/**
 * PRE-REGISTERED success criteria for v0.4.0 "Decision Judge -> Evidence Gate".
 * Written and committed BEFORE any v0.4.0 model run; must not be changed after seeing results.
 * See docs/v0.4-evidence-gate.md for the full text.
 *
 * Applied to the evidence_gate mode, per model, on point estimates over successful runs:
 *   recall = MODIFY/REPLACE rate on MECHANICALLY CONFIRMABLE defect cases (defect_kind test|typecheck|search)
 *   FI     = MODIFY/REPLACE rate on correct proposals (WARNING is not an intervention)
 *
 *   continue      recall >= 0.90 AND FI <= 0.20
 *   archive       FI >= 0.40   (whole project)
 *   inconclusive  otherwise
 *   If more than 10% of a model's evidence_gate reviews failed (after retries), that model's label
 *   is "inconclusive (failures)" regardless of the rates.
 *
 * Project-level verdict: "continue" only if every model is "continue"; "archive" only if every model
 * is "archive"; otherwise "inconclusive". Untestable-defect recall is reported separately and is
 * not part of the criterion. Wilson 95% intervals are reported; with small n they are wide and
 * the report says so.
 */
export const CRITERIA = { continueMinRecall: 0.9, continueMaxFI: 0.2, archiveMinFI: 0.4, maxFailureShare: 0.1 } as const;

export type CriterionLabel = "continue" | "archive" | "inconclusive" | "inconclusive (failures)";

export function criterionLabel(recallTestable: Rate, fi: Rate, failureShare: number): CriterionLabel {
  if (failureShare > CRITERIA.maxFailureShare) return "inconclusive (failures)";
  if (recallTestable.rate === null || fi.rate === null) return "inconclusive";
  if (fi.rate >= CRITERIA.archiveMinFI) return "archive";
  if (recallTestable.rate >= CRITERIA.continueMinRecall && fi.rate <= CRITERIA.continueMaxFI) return "continue";
  return "inconclusive";
}

export function projectVerdict(labels: CriterionLabel[]): "continue" | "archive" | "inconclusive" {
  if (labels.length && labels.every((l) => l === "continue")) return "continue";
  if (labels.length && labels.every((l) => l === "archive")) return "archive";
  return "inconclusive";
}
