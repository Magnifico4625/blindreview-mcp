import type { ChatMessage } from "../providers/provider.js";
import { IndependentPositionSchema, ReviewError, ReviewVerdictSchema, type ReviewInput } from "../schemas/review.js";
import { budgetExhaustedVerdict, type ModeOutcome } from "./blind-first.js";
import { normalizePositionCandidate, normalizeVerdictCandidate } from "./json.js";
import { buildPass2VerdictMessage, buildProposalFirst2PassMessages } from "./prompts.js";
import type { ReviewSession } from "./session.js";

/**
 * BENCHMARK-ONLY compute-matched control. Not exposed through the MCP tool.
 * Same structure and budget handling as blind_first; the proposal is visible in pass 1.
 */
export async function runProposalFirst2Pass(session: ReviewSession, input: ReviewInput): Promise<ModeOutcome> {
  const pass1Messages = buildProposalFirst2PassMessages(input);
  const map = await session.structured(pass1Messages, IndependentPositionSchema, normalizePositionCandidate);
  const pass2Messages: ChatMessage[] = [...pass1Messages, { role: "assistant", content: JSON.stringify(map) }, buildPass2VerdictMessage()];
  try {
    session.completionBudgetFor(pass2Messages);
  } catch (err) {
    if (err instanceof ReviewError && err.code === "BUDGET_EXCEEDED") {
      return { verdict: budgetExhaustedVerdict(), phases: 1, budgetExhausted: true };
    }
    throw err;
  }
  const verdict = await session.structured(pass2Messages, ReviewVerdictSchema, normalizeVerdictCandidate);
  return { verdict, phases: 2 };
}
