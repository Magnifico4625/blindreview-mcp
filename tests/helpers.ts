import type { CompletionRequest, CompletionResponse, ReviewerProvider } from "../src/providers/provider.js";
import type { Config } from "../src/config.js";
import type { ReviewInput } from "../src/schemas/review.js";

export const SENTINEL = "ZQX-SENTINEL-7f3a9 use the purple-walrus sharding protocol with vector-clock-quorum";

export const validPosition = {
  main_assumptions: ["traffic is read-heavy"],
  directions: [
    { approach: "event-driven invalidation", pros: ["fresh"], cons: ["coupling"] },
    { approach: "short TTL", pros: ["simple"], cons: ["stale"] },
  ],
  failure_modes: ["stale permissions after revocation"],
  preferred_solution: "Invalidate on permission change events.",
  assumptions_to_test: ["events are reliable"],
};

export const validVerdict = {
  verdict: "MODIFY",
  recommendation: "Add event-driven invalidation.",
  critical_assumptions: ["revocations are rare"],
  material_risks: ["revoked users keep access for the TTL"],
  better_alternative: "Versioned cache keys bumped on permission.changed.",
  falsification_probe: { description: "Revoke access and read within 1 minute", expected_signal: "403 immediately" },
  confidence: 0.8,
};

export function makeInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    objective: "Reduce authorization latency",
    constraints: ["no API change"],
    context: "12 pods, Redis available",
    proposed_solution: SENTINEL,
    decision_type: "architecture",
    risk_level: "high",
    ...overrides,
  };
}

export const testConfig: Config = {
  baseUrl: "http://fake.local/v1",
  apiKey: undefined,
  model: "fake-model",
  reasoningEffort: undefined,
  reasoningParam: undefined,
  maxTokensPerCall: 2000,
  maxReviewTokens: 20000,
  maxToolCalls: 0,
  timeoutMs: 5000,
  telemetryEnabled: false,
  telemetryPath: "unused.jsonl",
};

type Responder = (req: CompletionRequest, index: number) => Promise<Partial<CompletionResponse> | string> | Partial<CompletionResponse> | string;

/** Scripted fake provider: records every request; responds with strings or partial responses. */
export class FakeProvider implements ReviewerProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  readonly requests: CompletionRequest[] = [];
  constructor(private readonly responder: Responder) {}

  static sequence(...answers: Array<unknown>): FakeProvider {
    return new FakeProvider((_req, i) => {
      const a = answers[Math.min(i, answers.length - 1)];
      return typeof a === "string" ? a : JSON.stringify(a);
    });
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const index = this.requests.length;
    this.requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
    const r = await this.responder(req, index);
    const partial = typeof r === "string" ? { content: r } : r;
    return {
      content: partial.content ?? "",
      usage: partial.usage ?? { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      toolCallCount: partial.toolCallCount ?? 0,
      model: partial.model ?? this.model,
    };
  }
}

export function allText(req: CompletionRequest): string {
  return req.messages.map((m) => m.content).join("\n");
}
