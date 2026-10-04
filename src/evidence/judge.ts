import { estimateTokens } from "../providers/provider.js";
import { buildRepairMessage } from "../reviewer/prompts.js";
import { extractJson } from "../reviewer/json.js";
import { ReviewError, type Usage } from "../schemas/review.js";
import { applyGate, GateAnswerSchema, normalizeGateAnswer, type ChangedLines, type GateAnswer, type GateOutcome, type GateVerdict, type ToolLogEntry } from "./gate.js";
import { BUDGET_EXHAUSTED_MESSAGE, buildEvidenceGateMessages, EVIDENCE_TOOLS, type RepoTaskView } from "./prompts.js";
import { SandboxError, type RepoSandbox, type ToolOutput } from "./sandbox.js";
import type { ToolCall, ToolChatProvider, WireMessage } from "./tool-provider.js";

export interface EvidenceGateLimits {
  /** Hard cap on executed tool calls per review. */
  maxToolCalls: number;
  /** Near-hard cap on cumulative prompt+completion tokens per review. */
  maxReviewTokens: number;
  maxTokensPerCall: number;
  timeoutMs: number;
}

export const DEFAULT_EVIDENCE_LIMITS: EvidenceGateLimits = { maxToolCalls: 8, maxReviewTokens: 80_000, maxTokensPerCall: 4000, timeoutMs: 300_000 };

export interface EvidenceGateResult {
  verdict: GateVerdict;
  answer: GateAnswer;
  gate: GateOutcome;
  tool_log: Array<ToolLogEntry & { output_preview: string }>;
  tool_calls_rejected: number;
  meta: {
    review_mode: "evidence_gate";
    model: string;
    usage: Usage;
    /** Sum of gateway-reported costs; null if any call reported none. */
    cost_usd: number | null;
    turns: number;
    latency_ms: number;
    forced_final: boolean;
    repaired: boolean;
  };
}

export class EvidenceGateError extends ReviewError {
  cost_usd: number | null = null;
}

export async function executeTool(sandbox: RepoSandbox, call: ToolCall): Promise<ToolOutput> {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = call.arguments.trim() ? JSON.parse(call.arguments) : {};
    args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { ok: false, text: "ERROR: tool arguments must be a JSON object", artifacts: [] };
  }
  try {
    switch (call.name) {
      case "search":
        return await sandbox.search(args);
      case "find_symbol":
        return await sandbox.findSymbol(args);
      case "read_file":
        return await sandbox.readFile(args);
      case "inspect_config":
        return await sandbox.inspectConfig(args);
      case "run_test":
        return await sandbox.runTest(args);
      case "typecheck":
        return await sandbox.typecheck();
      default:
        return { ok: false, text: `ERROR: unknown tool ${call.name}`, artifacts: [] };
    }
  } catch (err) {
    if (err instanceof SandboxError) return { ok: false, text: `ERROR: ${err.message}`, artifacts: [] };
    return { ok: false, text: `ERROR: tool failed: ${err instanceof Error ? err.message : String(err)}`, artifacts: [] };
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { _raw: raw.slice(0, 200) };
  } catch {
    return { _raw: raw.slice(0, 200) };
  }
}

/**
 * One evidence_gate review: tool loop (read-only sandbox tools, hard cap), final claim JSON,
 * then the harness gate (applyGate). Stateless apart from the sandbox it is given.
 */
export async function runEvidenceGate(opts: {
  provider: ToolChatProvider;
  sandbox: RepoSandbox;
  view: RepoTaskView;
  changed: ChangedLines;
  limits?: Partial<EvidenceGateLimits>;
}): Promise<EvidenceGateResult> {
  const limits = { ...DEFAULT_EVIDENCE_LIMITS, ...opts.limits };
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let cost: number | null = 0;
  let model = opts.provider.model;
  const messages: WireMessage[] = buildEvidenceGateMessages(opts.view, limits.maxToolCalls).map((m) => ({ role: m.role as "system" | "user", content: m.content }));
  const log: EvidenceGateResult["tool_log"] = [];
  let rejected = 0;
  let forcedFinal = false;
  let repaired = false;
  let turns = 0;
  const maxTurns = limits.maxToolCalls + 5;
  const fail = (code: ConstructorParameters<typeof ReviewError>[0], msg: string, status?: number): EvidenceGateError => {
    const e = new EvidenceGateError(code, msg, status !== undefined ? { status } : undefined);
    e.usage = { ...usage };
    e.cost_usd = cost;
    return e;
  };
  try {
    for (;;) {
      if (++turns > maxTurns) throw fail("MALFORMED_RESPONSE", `no final answer after ${maxTurns} model turns`);
      if (usage.total_tokens >= limits.maxReviewTokens) {
        if (forcedFinal) throw fail("BUDGET_EXCEEDED", `review token budget exhausted (${usage.total_tokens}/${limits.maxReviewTokens})`);
        messages.push({ role: "user", content: BUDGET_EXHAUSTED_MESSAGE });
        forcedFinal = true;
      }
      const allowTools = !forcedFinal && log.length < limits.maxToolCalls;
      const promptEstimate = messages.reduce((s, m) => s + estimateTokens(JSON.stringify(m)), 0);
      const maxTokens = Math.max(512, Math.min(limits.maxTokensPerCall, limits.maxReviewTokens - usage.total_tokens - promptEstimate));
      let res;
      try {
        res = await opts.provider.chat({ messages, tools: EVIDENCE_TOOLS, toolChoice: allowTools ? "auto" : "none", maxTokens, signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted) throw fail("TIMEOUT", `review exceeded ${limits.timeoutMs} ms`);
        if (err instanceof ReviewError) throw fail(err.code, err.message, err.status);
        throw err;
      }
      usage.prompt_tokens += res.usage.prompt_tokens;
      usage.completion_tokens += res.usage.completion_tokens;
      usage.total_tokens += res.usage.total_tokens;
      cost = cost === null || res.costUsd === null ? null : cost + res.costUsd;
      model = res.model || model;

      if (res.toolCalls.length) {
        messages.push({
          role: "assistant",
          content: res.content || null,
          tool_calls: res.toolCalls.map((tc) => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.arguments } })),
        });
        for (const tc of res.toolCalls) {
          if (!allowTools || log.length >= limits.maxToolCalls) {
            rejected++;
            messages.push({ role: "tool", tool_call_id: tc.id, content: "ERROR: tool budget exhausted; no tool was run." });
            continue;
          }
          const id = `T${log.length + 1}`;
          const t0 = performance.now();
          const out = await executeTool(opts.sandbox, tc);
          log.push({ id, tool: tc.name, args: parseArgs(tc.arguments), ok: out.ok, artifacts: out.artifacts, output_chars: out.text.length, ms: Math.round(performance.now() - t0), output_preview: out.text.slice(0, 600) });
          messages.push({ role: "tool", tool_call_id: tc.id, content: `[${id}] ${out.text}` });
        }
        if (!forcedFinal && log.length >= limits.maxToolCalls) {
          messages.push({ role: "user", content: BUDGET_EXHAUSTED_MESSAGE });
          forcedFinal = true;
        }
        continue;
      }

      const json = extractJson(res.content);
      const parsed = json === undefined ? undefined : GateAnswerSchema.safeParse(normalizeGateAnswer(json));
      if (parsed?.success) {
        const answer = parsed.data;
        const gate = applyGate(answer, log, opts.changed);
        return {
          verdict: gate.final_verdict,
          answer,
          gate,
          tool_log: log,
          tool_calls_rejected: rejected,
          meta: { review_mode: "evidence_gate", model, usage, cost_usd: cost, turns, latency_ms: Math.round(performance.now() - started), forced_final: forcedFinal, repaired },
        };
      }
      if (repaired) {
        if (res.finishReason === "length") throw fail("OUTPUT_TRUNCATED", "final answer cut off by max_tokens");
        throw fail("MALFORMED_RESPONSE", `final answer invalid after one repair: ${parsed && !parsed.success ? parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "not a JSON object"}`);
      }
      repaired = true;
      forcedFinal = true;
      const problem = json === undefined ? (res.content.trim() ? "it was not a valid JSON object" : "it was empty") : `schema validation failed: ${parsed && !parsed.success ? parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") : ""}`;
      messages.push({ role: "assistant", content: res.content.slice(0, 4000) || "(empty)" });
      messages.push(buildRepairMessage(problem) as WireMessage);
    }
  } finally {
    clearTimeout(timer);
  }
}
