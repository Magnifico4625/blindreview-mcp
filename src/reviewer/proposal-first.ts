import { ReviewVerdictSchema, type ReviewInput } from "../schemas/review.js";
import { normalizeVerdictCandidate } from "./json.js";
import { buildProposalFirstMessages } from "./prompts.js";
import type { ReviewSession } from "./session.js";
import type { ModeOutcome } from "./blind-first.js";

/** Control mode for A/B: ordinary critique, the proposal is in the single request. */
export async function runProposalFirst(session: ReviewSession, input: ReviewInput): Promise<ModeOutcome> {
  const verdict = await session.structured(
    buildProposalFirstMessages(input),
    ReviewVerdictSchema,
    normalizeVerdictCandidate,
  );
  return { verdict, phases: 1 };
}
