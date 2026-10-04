import type { z } from "zod";
import { estimateMessagesTokens, type ChatMessage, type ReviewerProvider } from "../providers/provider.js";
import { ReviewError, type Usage } from "../schemas/review.js";
import { buildRepairMessage } from "./prompts.js";
import { extractJson } from "./json.js";

/** Smallest completion budget worth spending on a call. Below this a call is not attempted. */
export const MIN_COMPLETION_TOKENS = 256;

export interface SessionLimits {
  maxTokensPerCall: number;
  maxReviewTokens: number;
}

/**
 * One review execution. Holds the only state of a review (usage, model id, abort signal).
 * Created per review and discarded afterwards; nothing is persisted.
 *
 * Token budget (near-hard cap on MAX_REVIEW_TOKENS):
 *  - before each call: max_tokens = min(REVIEWER_MAX_TOKENS, remaining - conservative prompt estimate);
 *    if that is below MIN_COMPLETION_TOKENS the call is not made (BUDGET_EXCEEDED);
 *  - after each call: cumulative usage.total_tokens (provider-reported, estimate if missing) is
 *    compared with the cap; once reached, no further call is made.
 *  So a call can only cross the cap if the provider counts more prompt tokens than our
 *  (deliberately pessimistic) estimate; completion tokens never exceed the clamped max_tokens.
 */
export class ReviewSession {
  readonly usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  calls = 0;
  model: string;

  constructor(
    private readonly provider: ReviewerProvider,
    private readonly limits: SessionLimits,
    readonly signal: AbortSignal,
  ) {
    this.model = provider.model;
  }

  get remainingTokens(): number {
    return this.limits.maxReviewTokens - this.usage.total_tokens;
  }

  get exhausted(): boolean {
    return this.remainingTokens <= 0;
  }

  /** Completion tokens we may request for these messages, or throws BUDGET_EXCEEDED. */
  completionBudgetFor(messages: readonly ChatMessage[]): number {
    const available = this.remainingTokens - estimateMessagesTokens(messages);
    const maxTokens = Math.min(this.limits.maxTokensPerCall, available);
    if (this.exhausted || maxTokens < MIN_COMPLETION_TOKENS) {
      throw new ReviewError(
        "BUDGET_EXCEEDED",
        `Review token budget exhausted (used ${this.usage.total_tokens} of MAX_REVIEW_TOKENS=${this.limits.maxReviewTokens})`,
      );
    }
    return maxTokens;
  }

  private async call(messages: readonly ChatMessage[]): Promise<{ content: string; truncated: boolean }> {
    if (this.signal.aborted) throw abortReason(this.signal);
    const maxTokens = this.completionBudgetFor(messages);
    this.calls++;
    const res = await this.provider.complete({ messages, maxTokens, signal: this.signal });
    if (this.signal.aborted) throw abortReason(this.signal);
    this.usage.prompt_tokens += res.usage.prompt_tokens;
    this.usage.completion_tokens += res.usage.completion_tokens;
    this.usage.total_tokens += res.usage.total_tokens;
    this.model = res.model || this.model;
    if (res.toolCallCount > 0) {
      // The reviewer is given no tools; any tool call is never executed and makes the answer unusable.
      throw new UnusableAnswer(`you attempted ${res.toolCallCount} tool call(s) but no tools are available`, res.content);
    }
    return { content: res.content, truncated: res.finishReason === "length" };
  }

  /**
   * Call the provider and validate the JSON answer against `schema`.
   * - output cut by max_tokens (finish_reason "length") and unparsable -> OUTPUT_TRUNCATED, no retry;
   * - otherwise at most ONE repair retry (2 calls total), then MALFORMED_RESPONSE.
   */
  async structured<S extends z.ZodType>(
    messages: readonly ChatMessage[],
    schema: S,
    normalize: (v: unknown) => unknown = (v) => v,
  ): Promise<z.infer<S>> {
    let problem: string;
    let lastContent: string;
    try {
      const first = await this.call(messages);
      lastContent = first.content;
      const parsed = this.validate(first.content, schema, normalize);
      if (parsed.ok) return parsed.value;
      if (first.truncated) throw truncatedError();
      problem = parsed.problem;
    } catch (err) {
      if (!(err instanceof UnusableAnswer)) throw err;
      problem = err.message;
      lastContent = err.content;
    }

    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: lastContent.slice(0, 4000) || "(empty)" },
      buildRepairMessage(problem),
    ];
    let second: { content: string; truncated: boolean };
    try {
      second = await this.call(repairMessages);
    } catch (err) {
      if (err instanceof UnusableAnswer) {
        throw new ReviewError("MALFORMED_RESPONSE", `Reviewer response unusable after repair retry: ${err.message}`);
      }
      throw err;
    }
    const repaired = this.validate(second.content, schema, normalize);
    if (repaired.ok) return repaired.value;
    if (second.truncated) throw truncatedError();
    throw new ReviewError("MALFORMED_RESPONSE", `Reviewer response invalid after one repair retry: ${repaired.problem}`);
  }

  private validate<S extends z.ZodType>(
    content: string,
    schema: S,
    normalize: (v: unknown) => unknown,
  ): { ok: true; value: z.infer<S> } | { ok: false; problem: string } {
    const json = extractJson(content);
    if (json === undefined) {
      return { ok: false, problem: content.trim() ? "it was not a valid JSON object" : "it was empty" };
    }
    const result = schema.safeParse(normalize(json));
    if (result.success) return { ok: true, value: result.data };
    const issues = result.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, problem: `schema validation failed: ${issues}` };
  }
}

class UnusableAnswer extends Error {
  constructor(
    message: string,
    readonly content: string,
  ) {
    super(message);
  }
}

function truncatedError(): ReviewError {
  return new ReviewError(
    "OUTPUT_TRUNCATED",
    "Reviewer output was cut off by the per-call token limit (finish_reason=length). Raise REVIEWER_MAX_TOKENS (reasoning models spend part of it on hidden reasoning) or lower REVIEWER_REASONING_EFFORT.",
  );
}

function abortReason(signal: AbortSignal): ReviewError {
  const reason: unknown = signal.reason;
  return reason instanceof ReviewError ? reason : new ReviewError("TIMEOUT", "Review timed out");
}
