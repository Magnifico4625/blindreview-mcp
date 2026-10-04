import { z } from "zod";

export const DECISION_TYPES = [
  "architecture",
  "refactor",
  "debugging",
  "database",
  "api",
  "dependency",
  "performance",
  "security",
  "implementation",
  "other",
] as const;
export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export const REVIEW_MODES = ["blind_first", "proposal_first"] as const;
/** Benchmark-only compute-matched control. Not accepted by the MCP tool input. */
export const BENCHMARK_ONLY_MODES = ["proposal_first_2pass"] as const;
export const ALL_MODES = [...REVIEW_MODES, ...BENCHMARK_ONLY_MODES] as const;
export const VERDICTS = ["KEEP", "MODIFY", "REPLACE", "INSUFFICIENT_EVIDENCE"] as const;

export const DecisionTypeSchema = z.enum(DECISION_TYPES);
export const RiskLevelSchema = z.enum(RISK_LEVELS);
export const ReviewModeSchema = z.enum(REVIEW_MODES);
export const VerdictSchema = z.enum(VERDICTS);

export type DecisionType = z.infer<typeof DecisionTypeSchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type ReviewMode = z.infer<typeof ReviewModeSchema>;
export type AnyMode = (typeof ALL_MODES)[number];
export type Verdict = z.infer<typeof VerdictSchema>;

const MAX_TEXT = 60_000;

const NO_PLAN = "Describe the problem only. Do NOT put your planned solution, preferred approach or its wording here; it belongs in proposed_solution only (the blind phase must not see it).";

/** Raw shape of the review_decision tool input (used directly by the MCP SDK). */
export const reviewInputShape = {
  objective: z
    .string()
    .min(1)
    .max(4_000)
    .describe(`The goal / problem to solve, not the solution. ${NO_PLAN}`),
  constraints: z
    .array(z.string().min(1).max(2_000))
    .max(50)
    .describe(`Hard requirements: compatibility, SLAs, deadlines, forbidden approaches. ${NO_PLAN}`),
  context: z
    .string()
    .max(MAX_TEXT)
    .describe(`Relevant facts about the codebase/system (summaries and key snippets). ${NO_PLAN}`),
  proposed_solution: z
    .string()
    .min(1)
    .max(MAX_TEXT)
    .describe("Your proposed solution. The ONLY field that may describe it. Hidden from the reviewer until phase 2 in blind_first mode."),
  decision_type: DecisionTypeSchema.describe("Visible to the blind phase by design."),
  risk_level: RiskLevelSchema.describe("Visible to the blind phase by design."),
  review_mode: ReviewModeSchema.optional().describe(
    "blind_first (default): reviewer forms an independent position before seeing the proposal. proposal_first: control mode, plain critique.",
  ),
  environment: z
    .string()
    .max(8_000)
    .optional()
    .describe(`Runtime/deploy environment: versions, topology, scale, traffic. ${NO_PLAN}`),
  evidence: z
    .array(z.string().min(1).max(8_000))
    .max(30)
    .optional()
    .describe(`Observed facts: logs, error messages, benchmark numbers, test output. ${NO_PLAN}`),
};

export const ReviewInputSchema = z.object(reviewInputShape).strict();
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

/**
 * Everything Phase 1 (blind) is allowed to see. Built by explicit field picking,
 * so proposed_solution is physically absent.
 */
export interface BlindInput {
  objective: string;
  constraints: string[];
  context: string;
  decision_type: DecisionType;
  risk_level: RiskLevel;
  environment?: string;
  evidence?: string[];
}

export function toBlindInput(input: ReviewInput): BlindInput {
  const blind: BlindInput = {
    objective: input.objective,
    constraints: [...input.constraints],
    context: input.context,
    decision_type: input.decision_type,
    risk_level: input.risk_level,
  };
  if (input.environment !== undefined) blind.environment = input.environment;
  if (input.evidence !== undefined) blind.evidence = [...input.evidence];
  return blind;
}

/** Phase 1 internal output: the reviewer's independent position. Never returned to the caller. */
export const IndependentPositionSchema = z.object({
  main_assumptions: z.array(z.string()).max(12),
  directions: z
    .array(
      z.object({
        approach: z.string(),
        pros: z.array(z.string()).max(6).default([]),
        cons: z.array(z.string()).max(6).default([]),
      }),
    )
    .min(1)
    .max(5),
  failure_modes: z.array(z.string()).max(12),
  preferred_solution: z.string(),
  assumptions_to_test: z.array(z.string()).max(12),
});
export type IndependentPosition = z.infer<typeof IndependentPositionSchema>;

export const FalsificationProbeSchema = z.object({
  description: z.string().min(1),
  expected_signal: z.string().min(1),
});

/** What the reviewer model must return in the final phase. */
export const ReviewVerdictSchema = z.object({
  verdict: VerdictSchema,
  recommendation: z.string().min(1),
  critical_assumptions: z.array(z.string()).max(10),
  material_risks: z.array(z.string()).max(10),
  better_alternative: z.string().min(1).optional(),
  falsification_probe: FalsificationProbeSchema,
  confidence: z.number().min(0).max(1),
});
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const UsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const ReviewMetaSchema = z.object({
  review_id: z.string(),
  review_mode: z.enum(ALL_MODES),
  model: z.string(),
  phases: z.number().int().min(1).max(2),
  usage: UsageSchema,
  latency_ms: z.number().nonnegative(),
  budget_exhausted: z.boolean().optional(),
  blindness_warning: z.string().optional(),
});
export type ReviewMeta = z.infer<typeof ReviewMetaSchema>;

export const reviewResultShape = {
  ...ReviewVerdictSchema.shape,
  meta: ReviewMetaSchema,
};
export const ReviewResultSchema = z.object(reviewResultShape);
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export const ERROR_CODES = [
  "CONFIG_ERROR",
  "INVALID_INPUT",
  "PROVIDER_HTTP_ERROR",
  "PROVIDER_NETWORK_ERROR",
  "TIMEOUT",
  "MALFORMED_RESPONSE",
  "BUDGET_EXCEEDED",
  "OUTPUT_TRUNCATED",
  "BLINDNESS_LEAK",
  "INTERNAL_ERROR",
] as const;
export type ReviewErrorCode = (typeof ERROR_CODES)[number];

export class ReviewError extends Error {
  readonly code: ReviewErrorCode;
  readonly status: number | undefined;
  constructor(code: ReviewErrorCode, message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ReviewError";
    this.code = code;
    this.status = options?.status;
  }
}

export const OutcomeInputSchema = z.object({
  review_id: z.string().min(1).max(100),
  accepted_review: z.boolean().optional(),
  later_rework_required: z.boolean().optional(),
  review_was_useful: z.boolean().optional(),
});
export type OutcomeInput = z.infer<typeof OutcomeInputSchema>;
