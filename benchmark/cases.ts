import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DecisionTypeSchema, RiskLevelSchema, VerdictSchema, type AnyMode, type ReviewInput } from "../src/schemas/review.js";

/** Case file schema. Only `input` (minus review_mode) ever reaches the reviewer. */
export const BenchmarkCaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  has_hidden_flaw: z.boolean(),
  /** The single verdict the case author considers correct. */
  expected_verdict: VerdictSchema,
  /** Verdicts that are still acceptable (must include expected_verdict). */
  acceptable_verdicts: z.array(VerdictSchema).min(1),
  hidden_flaw: z.string().optional(),
  hidden_flaw_keywords: z.array(z.string()).default([]),
  notes: z.string().optional(),
  input: z.object({
    objective: z.string(),
    constraints: z.array(z.string()),
    context: z.string(),
    proposed_solution: z.string(),
    decision_type: DecisionTypeSchema,
    risk_level: RiskLevelSchema,
    environment: z.string().optional(),
    evidence: z.array(z.string()).optional(),
  }),
});
export type BenchmarkCase = z.infer<typeof BenchmarkCaseSchema>;

export async function loadCases(dir: string): Promise<BenchmarkCase[]> {
  const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".json")).sort();
  const cases: BenchmarkCase[] = [];
  for (const file of files) {
    const raw: unknown = JSON.parse(await readFile(path.join(dir, file), "utf8"));
    const parsed = BenchmarkCaseSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Invalid case ${file}: ${parsed.error.message}`);
    if (!parsed.data.acceptable_verdicts.includes(parsed.data.expected_verdict)) {
      throw new Error(`Invalid case ${file}: acceptable_verdicts must include expected_verdict`);
    }
    cases.push(parsed.data);
  }
  return cases;
}

/**
 * Build reviewer input by explicit field picking: hidden_flaw, hidden_flaw_keywords and notes
 * are never copied, so they cannot reach the reviewer.
 */
export function toReviewInput(c: BenchmarkCase, mode: AnyMode): ReviewInput {
  const i = c.input;
  const input: ReviewInput = {
    objective: i.objective,
    constraints: i.constraints,
    context: i.context,
    proposed_solution: i.proposed_solution,
    decision_type: i.decision_type,
    risk_level: i.risk_level,
    // the benchmark-only mode is selected via Reviewer options, not the public input field
    review_mode: mode === "proposal_first_2pass" ? "proposal_first" : mode,
  };
  if (i.environment !== undefined) input.environment = i.environment;
  if (i.evidence !== undefined) input.evidence = i.evidence;
  return input;
}
