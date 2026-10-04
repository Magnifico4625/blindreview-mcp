import type { Usage } from "../schemas/review.js";

/**
 * Provider abstraction. A provider only turns messages into text.
 * There is deliberately no `tools` field: the reviewer never gets tools,
 * so it cannot call review_decision, spawn reviewers or delegate.
 *
 * Future adapters (Anthropic, Gemini, OpenRouter-native, xAI-native, local runtimes)
 * implement this interface; nothing else in the code base depends on a vendor.
 */
export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface CompletionRequest {
  messages: readonly ChatMessage[];
  /** Max completion tokens for this call (already clamped to the remaining review budget). */
  maxTokens: number;
  /** Aborted when the review times out. Providers must honour it. */
  signal: AbortSignal;
}

export interface CompletionResponse {
  content: string;
  usage: Usage;
  /** Number of tool calls the model attempted. They are never executed. */
  toolCallCount: number;
  /** Model id reported by the API (falls back to the configured one). */
  model: string;
}

export interface ReviewerProvider {
  readonly name: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

/** Rough token estimate (~4 chars/token) used only for budget pre-checks and missing usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}
