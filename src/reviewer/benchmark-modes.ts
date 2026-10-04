import {
  IndependentPositionSchema,
  ReviewError,
  ReviewVerdictSchema,
  toBlindInput,
  type ReviewInput,
} from "../schemas/review.js";
import { budgetExhaustedVerdict, type ModeOutcome } from "./blind-first.js";
import { normalizePositionCandidate, normalizeVerdictCandidate } from "./json.js";
import { buildBlindPhase1Messages, buildDecisionJudgeMessages, buildIndependentComparerMessages } from "./prompts.js";
import type { ReviewSession } from "./session.js";

/**
 * BENCHMARK-ONLY modes added in v0.3.0. Not reachable through the MCP tool.
 *
 * independent_only:
 *   step 1 = exactly blind_first Phase 1 (same prompt, no proposal);
 *   step 2 = a FRESH conversation (no Phase-1 transcript, no problem statement) that gets only the
 *            Phase-1 structured position + the proposal and returns the verdict.
 *   The independent reviewer never sees proposed_solution; the comparer never sees the reviewer's
 *   conversation. Same session budget as blind_first. This isolates whether the in-session
 *   Reveal/Compare trajectory of blind_first matters.
 *
 * decision_judge (experiment): single pass, proposal shown, explicit "intervene only if
 *   warranted" instruction. Compared with proposal_first in a separate report section.
 */
export async function runIndependentOnly(session: ReviewSession, input: ReviewInput): Promise<ModeOutcome> {
  const phase1Messages = buildBlindPhase1Messages(toBlindInput(input));
  const position = await session.structured(phase1Messages, IndependentPositionSchema, normalizePositionCandidate);
  const comparer = buildIndependentComparerMessages(JSON.stringify(position, null, 2), input.proposed_solution);
  try {
    session.completionBudgetFor(comparer);
  } catch (err) {
    if (err instanceof ReviewError && err.code === "BUDGET_EXCEEDED") {
      return { verdict: budgetExhaustedVerdict(), phases: 1, budgetExhausted: true };
    }
    throw err;
  }
  const verdict = await session.structured(comparer, ReviewVerdictSchema, normalizeVerdictCandidate);
  return { verdict, phases: 2 };
}

export async function runDecisionJudge(session: ReviewSession, input: ReviewInput): Promise<ModeOutcome> {
  const verdict = await session.structured(buildDecisionJudgeMessages(input), ReviewVerdictSchema, normalizeVerdictCandidate);
  return { verdict, phases: 1 };
}
