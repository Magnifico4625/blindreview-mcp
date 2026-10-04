import { createHash } from "node:crypto";
import type { ChatMessage } from "../providers/provider.js";
import type { ReviewInput } from "../schemas/review.js";
import { toBlindInput } from "../schemas/review.js";
import * as P from "./prompts.js";

/**
 * Prompt fingerprints: every prompt builder is rendered with a fixed placeholder input and hashed.
 * Benchmark results record these hashes, and tests pin the frozen ones, so a silent prompt change
 * is detected. New prompts must be added as NEW modes with their own hash.
 */
export const FIXTURE_INPUT: ReviewInput = {
  objective: "{{objective}}",
  constraints: ["{{constraint_1}}", "{{constraint_2}}"],
  context: "{{context}}",
  proposed_solution: "{{proposed_solution}}",
  decision_type: "other",
  risk_level: "medium",
  environment: "{{environment}}",
  evidence: ["{{evidence_1}}"],
};
const FIXTURE_ASSISTANT: ChatMessage = { role: "assistant", content: "{{previous_answer}}" };

function hash(messages: readonly ChatMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex").slice(0, 16);
}

/** Message templates per mode (all calls of the mode, in order, with placeholders). */
export function promptTemplates(): Record<string, ChatMessage[]> {
  const blind1 = P.buildBlindPhase1Messages(toBlindInput(FIXTURE_INPUT));
  const pf2 = P.buildProposalFirst2PassMessages(FIXTURE_INPUT);
  return {
    proposal_first: P.buildProposalFirstMessages(FIXTURE_INPUT),
    proposal_first_2pass: [...pf2, FIXTURE_ASSISTANT, P.buildPass2VerdictMessage()],
    blind_first: [...blind1, FIXTURE_ASSISTANT, P.buildRevealMessage(FIXTURE_INPUT.proposed_solution)],
    repair: [P.buildRepairMessage("{{problem}}")],
    // added in v0.3.0
    independent_only: [
      ...blind1,
      FIXTURE_ASSISTANT,
      ...P.buildIndependentComparerMessages("{{position_json}}", FIXTURE_INPUT.proposed_solution),
    ],
    decision_judge: P.buildDecisionJudgeMessages(FIXTURE_INPUT),
  };
}

export function promptHashes(): Record<string, string> {
  return Object.fromEntries(Object.entries(promptTemplates()).map(([k, v]) => [k, hash(v)]));
}
