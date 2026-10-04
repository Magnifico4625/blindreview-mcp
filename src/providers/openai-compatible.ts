import { ReviewError } from "../schemas/review.js";
import type { Usage } from "../schemas/review.js";
import {
  estimateMessagesTokens,
  estimateTokens,
  type CompletionRequest,
  type CompletionResponse,
  type ReviewerProvider,
} from "./provider.js";

/**
 * How the reasoning effort is sent:
 *  - "reasoning_effort": OpenAI / xAI style top-level `reasoning_effort: "low"`
 *  - "reasoning_object": OpenRouter style `reasoning: { effort: "low" }`
 */
export type ReasoningParamStyle = "reasoning_effort" | "reasoning_object";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  model: string;
  reasoningEffort?: string | undefined;
  /** Defaults to "reasoning_object" for openrouter.ai, otherwise "reasoning_effort". */
  reasoningParam?: ReasoningParamStyle | undefined;
  /** Ask for JSON output via response_format (dropped automatically if unsupported). Default true. */
  jsonMode?: boolean;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Extra headers. */
  headers?: Record<string, string>;
}

interface ChatCompletionBody {
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: unknown[] | null; function_call?: unknown };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; code?: number | string };
}

const MAX_ERROR_BODY = 600;

export function defaultReasoningParam(baseUrl: string): ReasoningParamStyle {
  return /openrouter\.ai/i.test(baseUrl) ? "reasoning_object" : "reasoning_effort";
}

/**
 * Adapter for any OpenAI-compatible /chat/completions endpoint
 * (OpenAI, OpenRouter, xAI, Ollama, LM Studio, vLLM, ...).
 *
 * Optional parameters that some servers reject are retried away, each at most once:
 *  - reasoning_effort / reasoning -> dropped
 *  - max_tokens                   -> switched to max_completion_tokens (newer OpenAI reasoning models)
 *  - response_format              -> dropped (the prompt still demands JSON)
 * The adapter remembers what was rejected for subsequent calls. The retry loop is bounded.
 * The request never contains `tools`: the reviewer has no tools.
 */
export class OpenAICompatibleProvider implements ReviewerProvider {
  readonly name = "openai-compatible";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly reasoningParam: ReasoningParamStyle;
  private reasoningEffort: string | undefined;
  private jsonMode: boolean;
  private tokenParam: "max_tokens" | "max_completion_tokens" = "max_tokens";

  constructor(options: OpenAICompatibleOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.reasoningEffort = options.reasoningEffort;
    this.reasoningParam = options.reasoningParam ?? defaultReasoningParam(this.baseUrl);
    this.jsonMode = options.jsonMode ?? true;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = options.headers ?? {};
  }

  /** Visible for tests. */
  get state(): { reasoningEffort: string | undefined; jsonMode: boolean; tokenParam: string } {
    return { reasoningEffort: this.reasoningEffort, jsonMode: this.jsonMode, tokenParam: this.tokenParam };
  }

  buildBody(request: CompletionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      [this.tokenParam]: request.maxTokens,
    };
    if (this.jsonMode) body.response_format = { type: "json_object" };
    if (this.reasoningEffort) {
      if (this.reasoningParam === "reasoning_object") body.reasoning = { effort: this.reasoningEffort, exclude: true };
      else body.reasoning_effort = this.reasoningEffort;
    }
    return body;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    // Each fallback fires at most once, so this is bounded at 4 attempts.
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await this.post(this.buildBody(request), request.signal);
      if (response.ok) return this.parse(await this.readJson(response, request.signal), request);

      const text = await this.readText(response, request.signal);
      if ((response.status === 400 || response.status === 422) && this.applyFallback(text)) continue;
      throw httpError(response.status, text);
    }
    throw new ReviewError("PROVIDER_HTTP_ERROR", "Provider kept rejecting request parameters after all fallbacks");
  }

  /** Returns true if a parameter was dropped/changed and the request should be retried. */
  private applyFallback(errorText: string): boolean {
    const t = errorText.toLowerCase();
    if (this.reasoningEffort && t.includes("reasoning")) {
      this.reasoningEffort = undefined;
      return true;
    }
    if (this.tokenParam === "max_tokens" && t.includes("max_completion_tokens")) {
      this.tokenParam = "max_completion_tokens";
      return true;
    }
    if (this.jsonMode && (t.includes("response_format") || t.includes("json_object") || t.includes("json mode"))) {
      this.jsonMode = false;
      return true;
    }
    return false;
  }

  private async post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json", ...this.headers };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    try {
      return await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw transportError(err, signal);
    }
  }

  private async readText(response: Response, signal: AbortSignal): Promise<string> {
    try {
      return (await response.text()).slice(0, MAX_ERROR_BODY);
    } catch (err) {
      throw transportError(err, signal);
    }
  }

  private async readJson(response: Response, signal: AbortSignal): Promise<ChatCompletionBody> {
    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      throw transportError(err, signal);
    }
    try {
      return JSON.parse(text) as ChatCompletionBody;
    } catch {
      throw new ReviewError("MALFORMED_RESPONSE", `Provider returned a non-JSON body: ${text.slice(0, 200)}`);
    }
  }

  private parse(body: ChatCompletionBody, request: CompletionRequest): CompletionResponse {
    const choice = body?.choices?.[0];
    if (!choice || !choice.message) {
      // Some gateways (e.g. OpenRouter) report upstream errors with HTTP 200 and an `error` object.
      const detail = body?.error?.message ? `: ${body.error.message}` : "";
      if (body?.error) throw new ReviewError("PROVIDER_HTTP_ERROR", `Provider returned an error${detail}`);
      throw new ReviewError("MALFORMED_RESPONSE", "Provider response has no choices[0].message");
    }
    const content = typeof choice.message.content === "string" ? choice.message.content : "";
    const toolCallCount =
      (Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls.length : 0) +
      (choice.message.function_call ? 1 : 0);
    return {
      content,
      toolCallCount,
      model: typeof body.model === "string" && body.model ? body.model : this.model,
      usage: normalizeUsage(body.usage, request, content),
    };
  }
}

function normalizeUsage(raw: ChatCompletionBody["usage"], request: CompletionRequest, content: string): Usage {
  const prompt = num(raw?.prompt_tokens) ?? estimateMessagesTokens(request.messages);
  const completion = num(raw?.completion_tokens) ?? estimateTokens(content);
  const total = num(raw?.total_tokens) ?? prompt + completion;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: Math.max(total, prompt + completion) };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
}

function httpError(status: number, text: string): ReviewError {
  let hint = "";
  if (status === 401 || status === 403) hint = " (check REVIEWER_API_KEY / REVIEWER_BASE_URL)";
  else if (status === 404) hint = " (check REVIEWER_BASE_URL and REVIEWER_MODEL)";
  else if (status === 429) hint = " (rate limited or out of credits)";
  return new ReviewError("PROVIDER_HTTP_ERROR", `Provider HTTP ${status}${hint}: ${text.slice(0, 300)}`, { status });
}

function transportError(err: unknown, signal: AbortSignal): ReviewError {
  if (err instanceof ReviewError) return err;
  if (signal.aborted) {
    const reason: unknown = signal.reason;
    if (reason instanceof ReviewError) return reason;
    return new ReviewError("TIMEOUT", "Review timed out", { cause: err });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ReviewError("PROVIDER_NETWORK_ERROR", `Network error calling provider: ${message}`, { cause: err });
}
