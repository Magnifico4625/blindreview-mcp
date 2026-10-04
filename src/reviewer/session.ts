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
  maxToolCalls: number;
}

/**
 * One review execution. Holds the only state of a review (usage, model id, abort signal).
 * Created per review_decision call and discarded afterwards; nothing is persisted.
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

  /** Completion tokens we may request for these messages, or throws BUDGET_EXCEEDED. */
  completionBudgetFor(messages: readonly ChatMessage[]): number {
    const available = this.remainingTokens - estimateMessagesTokens(messages);
    const maxTokens = Math.min(this.limits.maxTokensPerCall, available);
    if (maxTokens < MIN_COMPLETION_TOKENS) {
      throw new ReviewError(
        "BUDGET_EXCEEDED",
        `Review token budget exhausted (used ${this.usage.total_tokens} of MAX_REVIEW_TOKENS=${this.limits.maxReviewTokens})`,
      );
    }
    return maxTokens;
  }

  private async call(messages: readonly ChatMessage[]): Promise<string> {
    if (this.signal.aborted) throw abortReason(this.signal);
    const maxTokens = this.completionBudgetFor(messages);
    this.calls++;
    const res = await this.provider.complete({ messages, maxTokens, signal: this.signal });
    if (this.signal.aborted) throw abortReason(this.signal);
    this.usage.prompt_tokens += res.usage.prompt_tokens;
    this.usage.completion_tokens += res.usage.completion_tokens;
    this.usage.total_tokens += res.usage.total_tokens;
    this.model = res.model || this.model;
    if (res.toolCallCount > this.limits.maxToolCalls) {
      // Tool calls are never executed. Treat as an unusable answer.
      throw new UnusableAnswer(
        `you attempted ${res.toolCallCount} tool call(s) but no tools are available (MAX_TOOL_CALLS=${this.limits.maxToolCalls})`,
        res.content,
      );
    }
    return res.content;
  }

  /**
   * Call the provider and validate the JSON answer against `schema`.
   * At most ONE repair retry (2 calls total), then a typed MALFORMED_RESPONSE error.
   */
  async structured<S extends z.ZodType>(
    messages: readonly ChatMessage[],
    schema: S,
    normalize: (v: unknown) => unknown = (v) => v,
  ): Promise<z.infer<S>> {
    let problem: string;
    let lastContent: string;
    try {
      lastContent = await this.call(messages);
      const parsed = this.validate(lastContent, schema, normalize);
      if (parsed.ok) return parsed.value;
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
    let content: string;
    try {
      content = await this.call(repairMessages);
    } catch (err) {
      if (err instanceof UnusableAnswer) {
        throw new ReviewError("MALFORMED_RESPONSE", `Reviewer response unusable after repair retry: ${err.message}`);
      }
      throw err;
    }
    const repaired = this.validate(content, schema, normalize);
    if (repaired.ok) return repaired.value;
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

function abortReason(signal: AbortSignal): ReviewError {
  const reason: unknown = signal.reason;
  return reason instanceof ReviewError ? reason : new ReviewError("TIMEOUT", "Review timed out");
}
