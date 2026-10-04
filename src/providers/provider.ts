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
  /** e.g. "stop" or "length" (output cut by max_tokens). */
  finishReason?: string | undefined;
}

export interface ReviewerProvider {
  readonly name: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

/**
 * Conservative token estimate used for budget pre-checks and when a provider omits usage.
 * ASCII ~3 chars/token (real tokenizers average ~4 for English, so this over-estimates);
 * every non-ASCII code point counts as one token (Cyrillic/CJK tokenize much worse than English).
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3) + other;
}

export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}
