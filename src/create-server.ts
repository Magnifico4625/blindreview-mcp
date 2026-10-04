import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { packageVersion, type Config } from "./config.js";
import { evaluateGate, gateInputShape, gateResultShape } from "./gate/decision-gate.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import type { ReviewerProvider } from "./providers/provider.js";
import { Reviewer } from "./reviewer/reviewer.js";
import { OutcomeInputSchema, ReviewError, reviewInputShape, reviewResultShape, type ReviewErrorCode } from "./schemas/review.js";
import { Telemetry } from "./telemetry/telemetry.js";

export const SERVER_NAME = "blindreview-mcp";
export const SERVER_VERSION = packageVersion();

export interface ServerDeps {
  config: Config;
  /** Override for tests; defaults to the OpenAI-compatible adapter built from config. */
  provider?: ReviewerProvider;
  telemetry?: Telemetry;
}

export function buildProvider(config: Config): ReviewerProvider {
  return new OpenAICompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    reasoningParam: config.reasoningParam,
    temperature: config.temperature,
  });
}

export function buildReviewer(config: Config, provider?: ReviewerProvider, telemetry?: Telemetry): Reviewer {
  return new Reviewer({
    provider: provider ?? buildProvider(config),
    maxTokensPerCall: config.maxTokensPerCall,
    maxReviewTokens: config.maxReviewTokens,
    timeoutMs: config.timeoutMs,
    blindnessLeakThreshold: config.blindnessLeakThreshold,
    blindnessWarnThreshold: config.blindnessWarnThreshold,
    telemetry,
  });
}

function errorResult(err: unknown): CallToolResult {
  const code: ReviewErrorCode = err instanceof ReviewError ? err.code : "INTERNAL_ERROR";
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }] };
}

function jsonResult(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

const REVIEW_DESCRIPTION = `Get ONE independent external review before an expensive decision (architecture, DB schema/migration, public API, key dependency, large refactor, security/performance, multi-hypothesis debugging). Default blind_first: the reviewer first solves the problem WITHOUT seeing proposed_solution, then the proposal is revealed and compared. Returns a compact verdict (KEEP | MODIFY | REPLACE | INSUFFICIENT_EVIDENCE), risks, an optional better alternative and the cheapest falsification probe to run. Costs one or two LLM calls; skip it for trivial changes (see should_review).
BLINDNESS CONTRACT: describe the problem in objective/constraints/context/environment/evidence and put your plan ONLY in proposed_solution. Do not mention, hint at or paraphrase your planned solution in the other fields. decision_type and risk_level are visible to the blind phase. If proposed_solution is largely copied into the other fields, blind_first refuses with BLINDNESS_LEAK.`;

export function createServer(deps: ServerDeps): McpServer {
  const telemetry = deps.telemetry ?? new Telemetry(deps.config.telemetryEnabled, deps.config.telemetryPath);
  const reviewer = buildReviewer(deps.config, deps.provider, telemetry);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "review_decision",
    {
      title: "Blind independent review of a decision",
      description: REVIEW_DESCRIPTION,
      inputSchema: reviewInputShape,
      outputSchema: reviewResultShape,
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await reviewer.review(args);
        return jsonResult(result as unknown as Record<string, unknown>);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "should_review",
    {
      title: "Deterministic review gate",
      description:
        "Deterministic (no LLM, free) check whether a decision is expensive enough to justify review_decision. Advisory only.",
      inputSchema: gateInputShape,
      outputSchema: gateResultShape,
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async (args): Promise<CallToolResult> => {
      try {
        return jsonResult({ ...evaluateGate(args) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "record_outcome",
    {
      title: "Record what happened after a review",
      description:
        "Append an outcome record for a past review (local telemetry only, requires TELEMETRY_ENABLED=true). Use review_id from review_decision meta.",
      inputSchema: OutcomeInputSchema.shape,
      outputSchema: { recorded: z.boolean(), note: z.string() },
      annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: false },
    },
    async (args): Promise<CallToolResult> => {
      const recorded = await telemetry.recordOutcome(args);
      return jsonResult({
        recorded,
        note: recorded ? `Outcome appended to ${telemetry.filePath}` : "Telemetry is disabled (TELEMETRY_ENABLED=false); nothing recorded.",
      });
    },
  );

  return server;
}
