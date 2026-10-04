import type { ChatMessage } from "../providers/provider.js";
import {
  IndependentPositionSchema,
  ReviewError,
  ReviewVerdictSchema,
  toBlindInput,
  type ReviewInput,
  type ReviewVerdict,
} from "../schemas/review.js";
import { normalizePositionCandidate, normalizeVerdictCandidate } from "./json.js";
import { buildBlindPhase1Messages, buildRevealMessage } from "./prompts.js";
import type { ReviewSession } from "./session.js";

export interface ModeOutcome {
  verdict: ReviewVerdict;
  phases: 1 | 2;
  budgetExhausted?: boolean;
}

/**
 * Blind-first review.
 * Phase 1: reviewer sees ONLY BlindInput (no proposed_solution) and forms an independent position.
 * Phase 2: same session. Messages = Phase 1 messages + Phase 1 answer + reveal of the proposal.
 * The Phase 1 position is internal and never returned.
 *
 * Budget policy: if Phase 1 leaves too little budget for Phase 2, Phase 2 is skipped and the
 * review returns INSUFFICIENT_EVIDENCE with meta.budget_exhausted=true (confidence 0). If the
 * budget is exhausted before/inside Phase 1, a BUDGET_EXCEEDED error is raised instead.
 */
export async function runBlindFirst(session: ReviewSession, input: ReviewInput): Promise<ModeOutcome> {
  const phase1Messages = buildBlindPhase1Messages(toBlindInput(input));
  const position = await session.structured(phase1Messages, IndependentPositionSchema, normalizePositionCandidate);

  const phase2Messages: ChatMessage[] = [
    ...phase1Messages,
    { role: "assistant", content: JSON.stringify(position) },
    buildRevealMessage(input.proposed_solution),
  ];

  try {
    session.completionBudgetFor(phase2Messages);
  } catch (err) {
    if (err instanceof ReviewError && err.code === "BUDGET_EXCEEDED") {
      return { verdict: budgetExhaustedVerdict(), phases: 1, budgetExhausted: true };
    }
    throw err;
  }

  const verdict = await session.structured(phase2Messages, ReviewVerdictSchema, normalizeVerdictCandidate);
  return { verdict, phases: 2 };
}

function budgetExhaustedVerdict(): ReviewVerdict {
  return {
    verdict: "INSUFFICIENT_EVIDENCE",
    recommendation:
      "Review incomplete: the token budget was used up by the blind phase before the proposal could be compared. Increase MAX_REVIEW_TOKENS or shorten the context and re-run.",
    critical_assumptions: [],
    material_risks: [],
    falsification_probe: {
      description: "Re-run review_decision with a larger MAX_REVIEW_TOKENS (or a smaller context).",
      expected_signal: "A completed two-phase review with a KEEP/MODIFY/REPLACE verdict.",
    },
    confidence: 0,
  };
}
