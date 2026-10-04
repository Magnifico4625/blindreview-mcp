import { ReviewError, type Usage } from "../schemas/review.js";
import type { ToolDefinition } from "./prompts.js";

/**
 * Tool-calling chat provider for evidence_gate (OpenAI-compatible /chat/completions, e.g. OpenRouter).
 * Separate from ReviewerProvider on purpose: the v0.1–v0.3 reviewer path stays tool-free.
 * Tool calls returned here are executed ONLY by the evidence_gate harness against the read-only
 * sandbox tools; nothing else is ever executed.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type WireMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolChatRequest {
  messages: readonly WireMessage[];
  tools: readonly ToolDefinition[];
  toolChoice: "auto" | "none";
  maxTokens: number;
  signal: AbortSignal;
}

export interface ToolChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /** USD cost reported by the gateway (OpenRouter usage.cost), if any. */
  costUsd: number | null;
  model: string;
  finishReason?: string | undefined;
}

export interface ToolChatProvider {
  readonly model: string;
  chat(request: ToolChatRequest): Promise<ToolChatResponse>;
}

interface Body {
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
  error?: { message?: string };
}

export interface OpenAIToolProviderOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  model: string;
  temperature?: number | undefined;
  reasoningEffort?: string | undefined;
  fetchImpl?: typeof fetch;
}

export class OpenAIToolProvider implements ToolChatProvider {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private temperature: number | undefined;
  private reasoningEffort: string | undefined;
  private sendToolChoice = true;

  constructor(o: OpenAIToolProviderOptions) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, "");
    this.apiKey = o.apiKey;
    this.model = o.model;
    this.temperature = o.temperature;
    this.reasoningEffort = o.reasoningEffort;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  buildBody(req: ToolChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: req.messages,
      tools: req.tools,
      max_tokens: req.maxTokens,
      usage: { include: true },
    };
    if (this.sendToolChoice) body.tool_choice = req.toolChoice;
    if (this.temperature !== undefined) body.temperature = this.temperature;
    if (this.reasoningEffort) body.reasoning = { effort: this.reasoningEffort, exclude: true };
    return body;
  }

  async chat(req: ToolChatRequest): Promise<ToolChatResponse> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(this.buildBody(req)), signal: req.signal });
      } catch (err) {
        if (req.signal.aborted) throw new ReviewError("TIMEOUT", "Review timed out");
        throw new ReviewError("PROVIDER_NETWORK_ERROR", `Network error: ${err instanceof Error ? err.message : String(err)}`);
      }
      const text = await res.text();
      if (!res.ok) {
        const t = text.toLowerCase();
        if ((res.status === 400 || res.status === 422) && this.sendToolChoice && t.includes("tool_choice")) {
          this.sendToolChoice = false;
          continue;
        }
        if ((res.status === 400 || res.status === 422) && this.temperature !== undefined && t.includes("temperature")) {
          this.temperature = undefined;
          continue;
        }
        if ((res.status === 400 || res.status === 422) && this.reasoningEffort && t.includes("reasoning")) {
          this.reasoningEffort = undefined;
          continue;
        }
        throw new ReviewError("PROVIDER_HTTP_ERROR", `Provider HTTP ${res.status}: ${text.slice(0, 300)}`, { status: res.status });
      }
      let body: Body;
      try {
        body = JSON.parse(text) as Body;
      } catch {
        throw new ReviewError("MALFORMED_RESPONSE", `Provider returned a non-JSON body: ${text.slice(0, 200)}`);
      }
      const choice = body.choices?.[0];
      if (!choice?.message) {
        if (body.error) throw new ReviewError("PROVIDER_HTTP_ERROR", `Provider returned an error: ${body.error.message ?? "unknown"}`, { status: 502 });
        throw new ReviewError("MALFORMED_RESPONSE", "Provider response has no choices[0].message");
      }
      const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc, i) => ({
        id: tc.id || `call_${i}`,
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "{}",
      }));
      const p = body.usage?.prompt_tokens ?? 0;
      const c = body.usage?.completion_tokens ?? 0;
      return {
        content: typeof choice.message.content === "string" ? choice.message.content : "",
        toolCalls,
        usage: { prompt_tokens: p, completion_tokens: c, total_tokens: body.usage?.total_tokens ?? p + c },
        costUsd: typeof body.usage?.cost === "number" ? body.usage.cost : null,
        model: body.model ?? this.model,
        finishReason: choice.finish_reason ?? undefined,
      };
    }
    throw new ReviewError("PROVIDER_HTTP_ERROR", "Provider kept rejecting request parameters");
  }
}
