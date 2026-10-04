import { randomUUID } from "node:crypto";
import type { ReviewerProvider } from "../providers/provider.js";
import { ReviewError, ReviewInputSchema, type AnyMode, type ReviewInput, type ReviewResult } from "../schemas/review.js";
import type { Telemetry } from "../telemetry/telemetry.js";
import { runBlindFirst, type ModeOutcome } from "./blind-first.js";
import { proposalContainment } from "./blindness.js";
import { runProposalFirst } from "./proposal-first.js";
import { runProposalFirst2Pass } from "./proposal-first-2pass.js";
import { ReviewSession, type SessionLimits } from "./session.js";

export interface ReviewerOptions extends SessionLimits {
  provider: ReviewerProvider;
  timeoutMs: number;
  /** Containment threshold above which blind_first refuses (BLINDNESS_LEAK). Default 0.5. */
  blindnessLeakThreshold?: number;
  /** Containment threshold above which meta.blindness_warning is set. Default 0.15. */
  blindnessWarnThreshold?: number;
  telemetry?: Telemetry | undefined;
}

export interface ReviewOptions {
  /** Benchmark-only: run the compute-matched control. Not reachable from the MCP tool. */
  benchmarkMode?: "proposal_first_2pass";
}

/**
 * Exactly one reviewer. Recursion is structurally impossible: the provider interface has no
 * tools field, requests never carry tools, and tool calls in answers are never executed.
 * The only path to the model is ReviewSession.call(), used by the three mode functions.
 */
export class Reviewer {
  constructor(private readonly options: ReviewerOptions) {}

  async review(rawInput: unknown, reviewOptions: ReviewOptions = {}): Promise<ReviewResult> {
    const parsed = ReviewInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      throw new ReviewError("INVALID_INPUT", `Invalid review input: ${issues}`);
    }
    const input = parsed.data;
    const mode: AnyMode = reviewOptions.benchmarkMode ?? input.review_mode ?? "blind_first";
    const reviewId = randomUUID();
    const started = performance.now();

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new ReviewError("TIMEOUT", `Review exceeded REVIEW_TIMEOUT=${this.options.timeoutMs}ms`)),
      this.options.timeoutMs,
    );
    // The session is the only state of this review; it goes out of scope when we return.
    const session = new ReviewSession(this.options.provider, this.options, controller.signal);

    try {
      const blindnessWarning = this.checkBlindness(input, mode);
      const outcome = await this.runMode(mode, session, input);
      const result: ReviewResult = {
        ...outcome.verdict,
        meta: {
          review_id: reviewId,
          review_mode: mode,
          model: session.model,
          phases: outcome.phases,
          usage: { ...session.usage },
          latency_ms: Math.round(performance.now() - started),
          ...(outcome.budgetExhausted ? { budget_exhausted: true } : {}),
          ...(blindnessWarning ? { blindness_warning: blindnessWarning } : {}),
        },
      };
      await this.options.telemetry?.recordReview({
        id: reviewId,
        review_mode: mode,
        decision_type: input.decision_type,
        risk_level: input.risk_level,
        reviewer_model: session.model,
        usage: result.meta.usage,
        latency_ms: result.meta.latency_ms,
        verdict: result.verdict,
        confidence: result.confidence,
        status: "ok",
      });
      return result;
    } catch (err) {
      const error =
        err instanceof ReviewError
          ? err
          : new ReviewError("INTERNAL_ERROR", err instanceof Error ? err.message : String(err), { cause: err });
      await this.options.telemetry?.recordReview({
        id: reviewId,
        review_mode: mode,
        decision_type: input.decision_type,
        risk_level: input.risk_level,
        reviewer_model: session.model,
        usage: { ...session.usage },
        latency_ms: Math.round(performance.now() - started),
        status: "error",
        error_code: error.code,
      });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Blindness contract: refuse blind_first when the proposal is largely already present in the
   * blind fields (the blind phase would not be blind); warn above a lower threshold.
   * Other modes only get the warning (the proposal is visible to them anyway).
   */
  private checkBlindness(input: ReviewInput, mode: AnyMode): string | undefined {
    const leak = this.options.blindnessLeakThreshold ?? 0.5;
    const warn = Math.min(this.options.blindnessWarnThreshold ?? 0.15, leak);
    const score = proposalContainment(input);
    const pct = `${Math.round(score * 100)}%`;
    if (mode === "blind_first" && score >= leak) {
      throw new ReviewError(
        "BLINDNESS_LEAK",
        `${pct} of proposed_solution's 5-word phrases already appear in objective/constraints/context/environment/evidence (threshold ${Math.round(leak * 100)}%). Remove the plan from those fields and call again.`,
      );
    }
    if (score >= warn) {
      return `${pct} of proposed_solution's 5-word phrases also appear in the blind fields; the blind phase may have seen part of the plan.`;
    }
    return undefined;
  }

  private runMode(mode: AnyMode, session: ReviewSession, input: ReviewInput): Promise<ModeOutcome> {
    const work =
      mode === "proposal_first"
        ? runProposalFirst(session, input)
        : mode === "proposal_first_2pass"
          ? runProposalFirst2Pass(session, input)
          : runBlindFirst(session, input);
    // Race with the abort signal so a provider that ignores the signal cannot hang the review.
    return new Promise<ModeOutcome>((resolve, reject) => {
      const onAbort = () =>
        reject(session.signal.reason instanceof ReviewError ? session.signal.reason : new ReviewError("TIMEOUT", "Review timed out"));
      if (session.signal.aborted) return onAbort();
      session.signal.addEventListener("abort", onAbort, { once: true });
      work.then(resolve, reject).finally(() => session.signal.removeEventListener("abort", onAbort));
    });
  }
}
