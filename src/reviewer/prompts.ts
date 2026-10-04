import type { BlindInput, ReviewInput } from "../schemas/review.js";
import type { ChatMessage } from "../providers/provider.js";

/**
 * Prompt builders. Phase 1 builders accept only BlindInput, a type that has no
 * proposed_solution field, so the proposal cannot leak into Phase 1 by construction.
 */

const SHARED_RULES = `You are the single independent reviewer for an AI coding agent (the "main agent").
Hard rules:
- You are exactly one reviewer. You have no tools. Do not delegate, simulate other reviewers, vote or debate.
- Be concrete and technical. Prefer facts given in the task; mark guesses as assumptions.
- Do not output your hidden reasoning. Output only the requested JSON object, nothing else.`;

const VERDICT_FORMAT = `Return ONLY a JSON object with exactly these fields:
{
  "verdict": "KEEP" | "MODIFY" | "REPLACE" | "INSUFFICIENT_EVIDENCE",
  "recommendation": string,            // 1-4 sentences, actionable
  "critical_assumptions": string[],     // assumptions the proposal silently depends on (max 5)
  "material_risks": string[],           // concrete risks that would cause real damage (max 5)
  "better_alternative": string,         // OMIT this field unless a clearly better approach exists
  "falsification_probe": {              // the single cheapest concrete check that could prove the proposal wrong
    "description": string,              // e.g. a test, shell command, SQL query, API/type check, benchmark, doc lookup
    "expected_signal": string           // what result would falsify / confirm it
  },
  "confidence": number                  // 0..1, your confidence in the verdict
}
Verdict meaning: KEEP = proposal is sound as is; MODIFY = right direction, needs specific changes;
REPLACE = fundamentally flawed, use a different approach; INSUFFICIENT_EVIDENCE = cannot judge without the probe.
Keep the whole answer under ~600 words.`;

const POSITION_FORMAT = `Return ONLY a JSON object with exactly these fields:
{
  "main_assumptions": string[],      // what must be true about the system (max 6)
  "directions": [                    // 2-4 genuinely different solution directions
    { "approach": string, "pros": string[], "cons": string[] }
  ],
  "failure_modes": string[],         // how solutions to this problem typically fail here (max 6)
  "preferred_solution": string,      // your own preferred direction and why, 2-5 sentences
  "assumptions_to_test": string[]    // cheapest facts to verify before committing (max 5)
}
Keep the whole answer under ~500 words.`;

function renderTask(input: BlindInput): string {
  const parts: string[] = [
    `## Decision type\n${input.decision_type}`,
    `## Risk level\n${input.risk_level}`,
    `## Objective\n${input.objective}`,
    `## Constraints\n${input.constraints.length ? input.constraints.map((c) => `- ${c}`).join("\n") : "(none given)"}`,
    `## Context\n${input.context || "(none given)"}`,
  ];
  if (input.environment) parts.push(`## Environment\n${input.environment}`);
  if (input.evidence?.length) parts.push(`## Evidence\n${input.evidence.map((e) => `- ${e}`).join("\n")}`);
  return parts.join("\n\n");
}

/** Phase 1 (blind): independent position. Receives NO proposed solution. */
export function buildBlindPhase1Messages(input: BlindInput): ChatMessage[] {
  return [
    {
      role: "system",
      content: `${SHARED_RULES}
This is phase 1 of a blind review. You have NOT been shown the main agent's solution and must not guess it.
Think about the problem from first principles and form your own independent position.`,
    },
    {
      role: "user",
      content: `${renderTask(input)}\n\n## Your task\nForm an independent position on how this decision should be made.\n\n${POSITION_FORMAT}`,
    },
  ];
}

/** Phase 2 (reveal): appended to the same session after the Phase 1 answer. */
export function buildRevealMessage(proposedSolution: string): ChatMessage {
  return {
    role: "user",
    content: `Phase 2: reveal. Here is the main agent's proposed solution:

<proposed_solution>
${proposedSolution}
</proposed_solution>

Compare it against YOUR independent position above, not against itself.
- Where it diverges from your position, decide who is right and why.
- Check it against each failure mode and assumption you listed.
- Do not be anchored by its framing; do not invent objections either. KEEP is a valid verdict.

${VERDICT_FORMAT}`,
  };
}

/** Control mode: ordinary critique, proposal shown immediately, single phase. */
export function buildProposalFirstMessages(input: ReviewInput): ChatMessage[] {
  const blindPart: BlindInput = {
    objective: input.objective,
    constraints: input.constraints,
    context: input.context,
    decision_type: input.decision_type,
    risk_level: input.risk_level,
    ...(input.environment !== undefined ? { environment: input.environment } : {}),
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
  };
  return [
    { role: "system", content: `${SHARED_RULES}\nReview the main agent's proposed solution.` },
    {
      role: "user",
      content: `${renderTask(blindPart)}

## Proposed solution
<proposed_solution>
${input.proposed_solution}
</proposed_solution>

## Your task
Critique the proposed solution. KEEP is a valid verdict.

${VERDICT_FORMAT}`,
    },
  ];
}

export function buildRepairMessage(problem: string): ChatMessage {
  return {
    role: "user",
    content: `Your previous answer could not be used: ${problem}
Return ONLY the corrected JSON object with the required fields. No prose, no markdown fences.`,
  };
}
