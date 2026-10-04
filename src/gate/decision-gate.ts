import { z } from "zod";
import { DecisionTypeSchema, RiskLevelSchema, type RiskLevel } from "../schemas/review.js";

/**
 * Deterministic decision gate (no LLM). Recommends whether a decision is expensive enough
 * to justify one extra reviewer. The main agent still decides whether to call review_decision.
 */
export const TRIVIAL_KINDS = ["formatting", "rename", "simple_ui", "obvious_bugfix", "docs", "small_local_change"] as const;

export const gateInputShape = {
  decision_type: DecisionTypeSchema,
  risk_level: RiskLevelSchema,
  summary: z.string().max(2_000).optional().describe("One-line description of the change (scanned for keywords)."),
  files_changed: z.number().int().nonnegative().optional(),
  modules_touched: z.number().int().nonnegative().optional(),
  changes_public_api: z.boolean().optional(),
  changes_db_schema: z.boolean().optional(),
  includes_migration: z.boolean().optional(),
  replaces_key_dependency: z.boolean().optional(),
  security_sensitive: z.boolean().optional(),
  performance_critical: z.boolean().optional(),
  irreversible: z.boolean().optional(),
  competing_hypotheses: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Debugging: number of plausible root-cause hypotheses still open."),
  trivial_kind: z.enum(TRIVIAL_KINDS).optional().describe("Set if the change is one of the known-cheap kinds."),
};
export const GateInputSchema = z.object(gateInputShape);
export type GateInput = z.infer<typeof GateInputSchema>;

export const gateResultShape = {
  should_review: z.boolean(),
  reasons: z.array(z.string()),
};
export type GateResult = { should_review: boolean; reasons: string[] };

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

const KEYWORDS: Array<[RegExp, string]> = [
  [/\b(migrat\w*|alter\s+table|drop\s+(column|table)|schema\s+change)/i, "summary mentions a schema change / migration"],
  [/\b(breaking\s+change|public\s+api|api\s+contract|wire\s+format|deprecat\w*)/i, "summary mentions a public API / contract change"],
  [/\b(replace|swap|switch)\b.{0,40}\b(orm|framework|database|queue|broker|cache|library|sdk)\b/i, "summary mentions replacing a key dependency"],
  [/\b(auth\w*|permission|crypto\w*|secret|xss|csrf|injection)\b/i, "summary mentions security-sensitive code"],
  [/\b(race|deadlock|concurren\w*|distributed\s+lock)\b/i, "summary mentions concurrency"],
];

export function evaluateGate(raw: GateInput): GateResult {
  const input = GateInputSchema.parse(raw);
  const reasons: string[] = [];
  const risk = RISK_ORDER[input.risk_level];

  if (input.decision_type === "architecture") reasons.push("architecture change");
  if (input.decision_type === "database" || input.changes_db_schema) reasons.push("database schema change");
  if (input.includes_migration) reasons.push("data/schema migration");
  if (input.decision_type === "api" && input.changes_public_api !== false) reasons.push("API change");
  else if (input.changes_public_api) reasons.push("public API change");
  if (input.replaces_key_dependency) reasons.push("key dependency replacement");
  if (input.decision_type === "security" || input.security_sensitive) reasons.push("security decision");
  if (input.decision_type === "performance" || input.performance_critical) reasons.push("performance decision");
  if (input.irreversible) reasons.push("hard-to-reverse decision");
  if ((input.modules_touched ?? 0) >= 3) reasons.push(`multi-module change (${input.modules_touched} modules)`);
  if ((input.files_changed ?? 0) >= 15) reasons.push(`large change (${input.files_changed} files)`);
  if (input.decision_type === "refactor" && ((input.files_changed ?? 0) >= 8 || (input.modules_touched ?? 0) >= 2)) {
    reasons.push("large refactor");
  }
  if (input.decision_type === "debugging" && (input.competing_hypotheses ?? 0) >= 2) {
    reasons.push(`complex debugging (${input.competing_hypotheses} plausible hypotheses)`);
  }
  if (input.summary) {
    for (const [re, why] of KEYWORDS) if (re.test(input.summary)) reasons.push(why);
  }

  // Trivial kinds are skipped unless a structural signal says otherwise.
  if (input.trivial_kind && reasons.length === 0 && risk < RISK_ORDER.high) {
    return { should_review: false, reasons: [`trivial change (${input.trivial_kind}); review not worth the cost`] };
  }
  if (risk >= RISK_ORDER.high) reasons.push(`${input.risk_level} risk`);

  // Low-risk performance tweaks alone are not worth a review.
  const onlyPerf = reasons.length === 1 && reasons[0] === "performance decision";
  if (onlyPerf && risk === RISK_ORDER.low && !input.performance_critical) {
    return { should_review: false, reasons: ["low-risk local performance tweak"] };
  }

  if (reasons.length === 0) {
    return { should_review: false, reasons: ["small local change with no expensive-decision signals"] };
  }
  return { should_review: true, reasons: [...new Set(reasons)] };
}
