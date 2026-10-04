import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DecisionTypeSchema, RiskLevelSchema, VerdictSchema, type ReviewInput } from "../src/schemas/review.js";

/**
 * Benchmark case schema (one JSON file per case in benchmark/cases/).
 * Only `input` is ever sent to a reviewer, via explicit field picking in toReviewInput().
 * `source`, `ground_truth` and `diagnostics` are human/evaluator-only.
 */
export const PROPOSAL_STATUSES = ["correct", "materially_flawed", "fundamentally_flawed", "insufficient_information"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export const SOURCE_TYPES = ["real_pr", "reverted_pr", "postmortem", "issue", "incident", "synthetic"] as const;

export const BenchmarkCaseSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    category: z.string().min(1),
    source: z.object({ type: z.enum(SOURCE_TYPES), url: z.string().url().optional(), note: z.string() }),
    input: z
      .object({
        objective: z.string().min(1),
        constraints: z.array(z.string()),
        context: z.string(),
        environment: z.string().optional(),
        evidence: z.array(z.string()).optional(),
        proposed_solution: z.string().min(1),
        decision_type: DecisionTypeSchema,
        risk_level: RiskLevelSchema,
      })
      .strict(),
    ground_truth: z.object({
      proposal_status: z.enum(PROPOSAL_STATUSES),
      /** First entry = primary (strictest expected) verdict, used for "exact verdict accuracy". */
      acceptable_verdicts: z.array(VerdictSchema).min(1),
      material_issue: z.string(),
      required_observations: z.array(z.string()),
      notes: z.string().default(""),
    }),
    diagnostics: z.object({ hidden_flaw_keywords: z.array(z.string()).optional() }).default({}),
  })
  .strict();
export type BenchmarkCase = z.infer<typeof BenchmarkCaseSchema>;

export const DEFAULT_CASES_DIR = path.join("benchmark", "cases");

export function isFlawed(c: BenchmarkCase): boolean {
  return c.ground_truth.proposal_status === "materially_flawed" || c.ground_truth.proposal_status === "fundamentally_flawed";
}

export function primaryVerdict(c: BenchmarkCase) {
  return c.ground_truth.acceptable_verdicts[0] as (typeof c.ground_truth.acceptable_verdicts)[number];
}

export async function loadCases(dir: string): Promise<{ cases: BenchmarkCase[]; hash: string }> {
  const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".json")).sort();
  const cases: BenchmarkCase[] = [];
  const h = createHash("sha256");
  const ids = new Set<string>();
  for (const file of files) {
    const text = (await readFile(path.join(dir, file), "utf8")).replace(/\r\n/g, "\n");
    h.update(file).update("\0").update(text).update("\0");
    const parsed = BenchmarkCaseSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`Invalid case ${file}: ${parsed.error.message}`);
    const c = parsed.data;
    if (ids.has(c.id)) throw new Error(`Duplicate case id ${c.id}`);
    ids.add(c.id);
    if (c.ground_truth.proposal_status === "correct" && c.ground_truth.acceptable_verdicts.some((v) => v === "REPLACE")) {
      throw new Error(`Invalid case ${file}: a correct proposal cannot accept REPLACE`);
    }
    if (isFlawed(c) && c.ground_truth.acceptable_verdicts.includes("KEEP")) {
      throw new Error(`Invalid case ${file}: a flawed proposal cannot accept KEEP`);
    }
    cases.push(c);
  }
  return { cases, hash: h.digest("hex").slice(0, 16) };
}

/** The ONLY bridge from a case to reviewer input: explicit field picking from case.input. */
export function toReviewInput(c: BenchmarkCase): ReviewInput {
  const i = c.input;
  const input: ReviewInput = {
    objective: i.objective,
    constraints: [...i.constraints],
    context: i.context,
    proposed_solution: i.proposed_solution,
    decision_type: i.decision_type,
    risk_level: i.risk_level,
  };
  if (i.environment !== undefined) input.environment = i.environment;
  if (i.evidence !== undefined) input.evidence = [...i.evidence];
  return input;
}
