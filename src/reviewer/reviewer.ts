import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ReviewerProvider } from "../providers/provider.js";
import {
  ReviewError,
  ReviewInputSchema,
  type ReviewMode,
  type ReviewResult,
} from "../schemas/review.js";
import type { Telemetry } from "../telemetry/telemetry.js";
import { runBlindFirst, type ModeOutcome } from "./blind-first.js";
import { runProposalFirst } from "./proposal-first.js";
import { ReviewSession, type SessionLimits } from "./session.js";

export interface ReviewerOptions extends SessionLimits {
  provider: ReviewerProvider;
  timeoutMs: number;
  telemetry?: Telemetry | undefined;
}

/**
 * Re-entrancy guard. Every review runs inside this async context; any review_decision
 * started from within a running review (e.g. a provider/tool callback trying to recurse)
 * sees the flag and is rejected. Independent top-level reviews do not share the context.
 */
const reviewContext = new AsyncLocalStorage<{ reviewId: string }>();

export function isInsideReview(): boolean {
  return reviewContext.getStore() !== undefined;
}

export function assertNotInsideReview(): void {
  const active = reviewContext.getStore();
  if (active) {
    throw new ReviewError(
      "RECURSION_BLOCKED",
      `Nested review_decision is not allowed (already inside review ${active.reviewId}). BlindReview uses exactly one reviewer.`,
    );
  }
}

export class Reviewer {
  constructor(private readonly options: ReviewerOptions) {}

  async review(rawInput: unknown): Promise<ReviewResult> {
    assertNotInsideReview();
    const parsed = ReviewInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      throw new ReviewError("INVALID_INPUT", `Invalid review input: ${issues}`);
    }
    const input = parsed.data;
    const mode: ReviewMode = input.review_mode ?? "blind_first";
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
      const outcome = await reviewContext.run({ reviewId }, () => this.runMode(mode, session, input));
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
          : new ReviewError("PROVIDER_NETWORK_ERROR", err instanceof Error ? err.message : String(err), { cause: err });
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

  private runMode(mode: ReviewMode, session: ReviewSession, input: Parameters<typeof runBlindFirst>[1]): Promise<ModeOutcome> {
    const work = mode === "proposal_first" ? runProposalFirst(session, input) : runBlindFirst(session, input);
    // Race with the abort signal so a provider that ignores the signal cannot hang the review.
    return new Promise<ModeOutcome>((resolve, reject) => {
      const onAbort = () => reject(session.signal.reason instanceof ReviewError ? session.signal.reason : new ReviewError("TIMEOUT", "Review timed out"));
      if (session.signal.aborted) return onAbort();
      session.signal.addEventListener("abort", onAbort, { once: true });
      work.then(resolve, reject).finally(() => session.signal.removeEventListener("abort", onAbort));
    });
  }
}
