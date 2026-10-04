import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { DecisionType, ReviewErrorCode, ReviewMode, RiskLevel, Usage, Verdict } from "../schemas/review.js";

/**
 * Opt-in local JSONL telemetry. Metadata only: no objective, context, proposal,
 * constraints, evidence or reviewer text is ever written. Records are built from an
 * explicit allowlist so new input fields cannot leak in by accident.
 */
export interface ReviewRecordInput {
  id: string;
  review_mode: ReviewMode;
  decision_type: DecisionType;
  risk_level: RiskLevel;
  reviewer_model: string;
  usage: Usage;
  latency_ms: number;
  status: "ok" | "error";
  verdict?: Verdict;
  confidence?: number;
  error_code?: ReviewErrorCode;
}

export interface OutcomeRecordInput {
  review_id: string;
  accepted_review?: boolean | undefined;
  later_rework_required?: boolean | undefined;
  review_was_useful?: boolean | undefined;
}

export class Telemetry {
  constructor(
    readonly enabled: boolean,
    readonly filePath: string,
  ) {}

  async recordReview(r: ReviewRecordInput): Promise<void> {
    const record: Record<string, unknown> = {
      type: "review",
      id: r.id,
      timestamp: new Date().toISOString(),
      review_mode: r.review_mode,
      decision_type: r.decision_type,
      risk_level: r.risk_level,
      reviewer_model: r.reviewer_model,
      usage: {
        prompt_tokens: r.usage.prompt_tokens,
        completion_tokens: r.usage.completion_tokens,
        total_tokens: r.usage.total_tokens,
      },
      latency_ms: r.latency_ms,
      status: r.status,
    };
    if (r.verdict !== undefined) record.verdict = r.verdict;
    if (r.confidence !== undefined) record.confidence = r.confidence;
    if (r.error_code !== undefined) record.error_code = r.error_code;
    await this.append(record);
  }

  async recordOutcome(o: OutcomeRecordInput): Promise<boolean> {
    const record: Record<string, unknown> = {
      type: "outcome",
      review_id: o.review_id,
      timestamp: new Date().toISOString(),
    };
    if (o.accepted_review !== undefined) record.accepted_review = o.accepted_review;
    if (o.later_rework_required !== undefined) record.later_rework_required = o.later_rework_required;
    if (o.review_was_useful !== undefined) record.review_was_useful = o.review_was_useful;
    return this.append(record);
  }

  async readAll(): Promise<Record<string, unknown>[]> {
    try {
      const text = await readFile(this.filePath, "utf8");
      return text
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  /** Never throws: telemetry must not break a review. Returns whether the record was written. */
  private async append(record: Record<string, unknown>): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
      return true;
    } catch (err) {
      console.error(`[blindreview] telemetry write failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
