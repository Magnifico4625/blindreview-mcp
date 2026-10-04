import { describe, expect, it } from "vitest";
import { Reviewer } from "../src/reviewer/reviewer.js";
import { ReviewError, ReviewResultSchema } from "../src/schemas/review.js";
import { FakeProvider, SENTINEL, allText, makeInput, testConfig, validPosition, validVerdict } from "./helpers.js";

function reviewer(provider: FakeProvider, overrides: Partial<typeof testConfig> = {}) {
  const c = { ...testConfig, ...overrides };
  return new Reviewer({ provider, ...c });
}

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(ReviewError);
  await p.catch((e: ReviewError) => expect(e.code).toBe(code));
}

describe("blind_first", () => {
  it("phase 1 contains NO text from proposed_solution (sentinel, substrings, tokens)", async () => {
    const provider = FakeProvider.sequence(validPosition, validVerdict);
    const result = await reviewer(provider).review(makeInput());
    expect(provider.requests).toHaveLength(2);
    const phase1 = allText(provider.requests[0]!);
    expect(phase1).not.toContain(SENTINEL);
    // every distinctive token and every 12-char window of the sentinel must be absent
    for (const token of SENTINEL.split(/\s+/).filter((t) => t.length >= 5)) expect(phase1).not.toContain(token);
    for (let i = 0; i + 12 <= SENTINEL.length; i++) expect(phase1).not.toContain(SENTINEL.slice(i, i + 12));
    expect(phase1).not.toMatch(/proposed_solution>/);
    expect(result.meta.phases).toBe(2);
  });

  it("reveals the proposal only in phase 2, in the same session (phase1 msgs + phase1 output + reveal)", async () => {
    const provider = FakeProvider.sequence(validPosition, validVerdict);
    await reviewer(provider).review(makeInput());
    const [p1, p2] = provider.requests;
    expect(p2!.messages.length).toBe(p1!.messages.length + 2);
    expect(p2!.messages.slice(0, p1!.messages.length)).toEqual(p1!.messages);
    const phase1Answer = p2!.messages[p1!.messages.length]!;
    expect(phase1Answer.role).toBe("assistant");
    expect(JSON.parse(phase1Answer.content)).toMatchObject({ preferred_solution: validPosition.preferred_solution });
    const reveal = p2!.messages[p1!.messages.length + 1]!;
    expect(reveal.role).toBe("user");
    expect(reveal.content).toContain(SENTINEL);
  });

  it("returns a compact typed result without the internal phase 1 position", async () => {
    const provider = FakeProvider.sequence(validPosition, validVerdict);
    const result = await reviewer(provider).review(makeInput());
    expect(ReviewResultSchema.parse(result)).toBeTruthy();
    const json = JSON.stringify(result);
    expect(json).not.toContain(validPosition.preferred_solution);
    expect(json).not.toContain("main_assumptions");
    expect(json).not.toContain("directions");
    expect(result.meta).toMatchObject({ review_mode: "blind_first", model: "fake-model" });
    expect(result.meta.usage.total_tokens).toBe(300);
    expect(json.length).toBeLessThan(4000);
  });

  it("default mode is blind_first", async () => {
    const provider = FakeProvider.sequence(validPosition, validVerdict);
    const result = await reviewer(provider).review(makeInput({ review_mode: undefined }));
    expect(result.meta.review_mode).toBe("blind_first");
  });
});

describe("proposal_first (control)", () => {
  it("sends the proposal in a single call", async () => {
    const provider = FakeProvider.sequence(validVerdict);
    const result = await reviewer(provider).review(makeInput({ review_mode: "proposal_first" }));
    expect(provider.requests).toHaveLength(1);
    expect(allText(provider.requests[0]!)).toContain(SENTINEL);
    expect(result.meta).toMatchObject({ review_mode: "proposal_first", phases: 1 });
  });
});

describe("single reviewer, no recursion (structural)", () => {
  it("requests carry only messages/maxTokens/signal: no tools can be given to the reviewer", async () => {
    const provider = FakeProvider.sequence(validPosition, validVerdict);
    await reviewer(provider).review(makeInput());
    for (const req of provider.requests) expect(Object.keys(req).sort()).toEqual(["maxTokens", "messages", "signal"]);
  });

  it("independent sequential and concurrent top-level reviews work", async () => {
    const provider = new FakeProvider((req) => JSON.stringify(req.messages.length > 2 ? validVerdict : validPosition));
    const r = reviewer(provider);
    await r.review(makeInput());
    const both = await Promise.all([r.review(makeInput()), r.review(makeInput())]);
    expect(both.map((b) => b.verdict)).toEqual(["MODIFY", "MODIFY"]);
  });
});

describe("benchmark-only proposal_first_2pass", () => {
  it("shows the proposal in pass 1 and appends pass-1 output + verdict request in pass 2", async () => {
    const provider = FakeProvider.sequence(validPosition, validVerdict);
    const result = await reviewer(provider).review(makeInput({ review_mode: "proposal_first" }), { benchmarkMode: "proposal_first_2pass" });
    const [p1, p2] = provider.requests;
    expect(allText(p1!)).toContain(SENTINEL);
    expect(allText(p1!)).toContain("main_assumptions");
    expect(p2!.messages.slice(0, p1!.messages.length)).toEqual(p1!.messages);
    expect(p2!.messages.at(-1)!.content).toContain('"verdict"');
    expect(result.meta).toMatchObject({ review_mode: "proposal_first_2pass", phases: 2 });
  });

  it("is not accepted through the public input field", async () => {
    const provider = FakeProvider.sequence(validVerdict);
    await expectCode(reviewer(provider).review({ ...makeInput(), review_mode: "proposal_first_2pass" }), "INVALID_INPUT");
  });
});

describe("blindness contract", () => {
  const plan =
    "Use versioned cache keys that are bumped by a Kafka consumer on every permission change event, keep a two minute TTL as backstop";

  it("refuses blind_first with BLINDNESS_LEAK when the plan is copied into context (no provider call)", async () => {
    const provider = FakeProvider.sequence(validPosition, validVerdict);
    const input = makeInput({ proposed_solution: plan, context: `12 pods. We are thinking to ${plan}.` });
    await expectCode(reviewer(provider).review(input), "BLINDNESS_LEAK");
    expect(provider.requests).toHaveLength(0);
  });

  it("detects a leak in objective/constraints/evidence/environment too", async () => {
    for (const field of ["objective", "environment"] as const) {
      const provider = FakeProvider.sequence(validPosition, validVerdict);
      await expectCode(reviewer(provider).review(makeInput({ proposed_solution: plan, [field]: plan })), "BLINDNESS_LEAK");
    }
    const provider = FakeProvider.sequence(validPosition, validVerdict);
    await expectCode(reviewer(provider).review(makeInput({ proposed_solution: plan, evidence: [plan] })), "BLINDNESS_LEAK");
  });

  it("warns (but runs) on partial overlap; proposal_first only warns", async () => {
    const partialContext = "Redis available. Idea: use versioned cache keys that are bumped by a Kafka consumer.";
    const provider = FakeProvider.sequence(validPosition, validVerdict);
    const result = await reviewer(provider).review(makeInput({ proposed_solution: plan, context: partialContext }));
    expect(result.meta.blindness_warning).toMatch(/5-word phrases/);

    const p2 = FakeProvider.sequence(validVerdict);
    const r2 = await reviewer(p2).review(makeInput({ proposed_solution: plan, context: plan, review_mode: "proposal_first" }));
    expect(r2.meta.blindness_warning).toBeDefined();
  });

  it("no warning when fields only share domain vocabulary", async () => {
    const provider = FakeProvider.sequence(validPosition, validVerdict);
    const result = await reviewer(provider).review(
      makeInput({ proposed_solution: plan, context: "Kafka topic permission-events exists. Redis cluster for sessions. 12 pods." }),
    );
    expect(result.meta.blindness_warning).toBeUndefined();
  });

  it("respects a configured threshold", async () => {
    const provider = FakeProvider.sequence(validPosition, validVerdict);
    const partialContext = "Idea: use versioned cache keys that are bumped by a Kafka consumer.";
    await expectCode(
      reviewer(provider, { blindnessLeakThreshold: 0.1, blindnessWarnThreshold: 0.05 }).review(makeInput({ proposed_solution: plan, context: partialContext })),
      "BLINDNESS_LEAK",
    );
  });
});

describe("parsing and repair", () => {
  it("accepts fenced JSON with prose and normalizes quirks", async () => {
    const quirky = { ...validVerdict, verdict: "keep", confidence: 85, better_alternative: "" };
    const provider = FakeProvider.sequence(
      `<think>hmm</think>Sure:\n\`\`\`json\n${JSON.stringify(validPosition)}\n\`\`\``,
      `Here you go ${JSON.stringify(quirky)} thanks`,
    );
    const result = await reviewer(provider).review(makeInput());
    expect(result.verdict).toBe("KEEP");
    expect(result.confidence).toBeCloseTo(0.85);
    expect(result.better_alternative).toBeUndefined();
  });

  it("does exactly one repair retry, then succeeds", async () => {
    const provider = FakeProvider.sequence(validPosition, "not json at all", validVerdict);
    const result = await reviewer(provider).review(makeInput());
    expect(provider.requests).toHaveLength(3);
    expect(allText(provider.requests[2]!)).toMatch(/could not be used/);
    expect(result.verdict).toBe("MODIFY");
  });

  it("fails with MALFORMED_RESPONSE after one failed repair (no infinite loop)", async () => {
    const provider = FakeProvider.sequence(validPosition, "{\"verdict\": \"MAYBE\"}");
    await expectCode(reviewer(provider).review(makeInput()), "MALFORMED_RESPONSE");
    expect(provider.requests).toHaveLength(3);
  });

  it("treats empty content as malformed", async () => {
    const provider = FakeProvider.sequence("", "");
    await expectCode(reviewer(provider).review(makeInput()), "MALFORMED_RESPONSE");
    expect(provider.requests).toHaveLength(2);
  });

  it("never executes tool calls; answers containing tool calls are unusable", async () => {
    const provider = new FakeProvider(() => ({ content: "", toolCallCount: 1 }));
    await expectCode(reviewer(provider).review(makeInput()), "MALFORMED_RESPONSE");
    expect(provider.requests).toHaveLength(2);
  });
});

describe("input validation", () => {
  it("rejects invalid input with INVALID_INPUT", async () => {
    const provider = FakeProvider.sequence(validVerdict);
    await expectCode(reviewer(provider).review({ ...makeInput(), risk_level: "extreme" }), "INVALID_INPUT");
    await expectCode(reviewer(provider).review({ objective: "x" }), "INVALID_INPUT");
    await expectCode(reviewer(provider).review({ ...makeInput(), hidden_flaw: "leak" }), "INVALID_INPUT");
    expect(provider.requests).toHaveLength(0);
  });
});

describe("timeout", () => {
  it("aborts with TIMEOUT even if the provider ignores the signal", async () => {
    const provider = new FakeProvider(() => new Promise<string>(() => {}));
    await expectCode(reviewer(provider, { timeoutMs: 50 }).review(makeInput()), "TIMEOUT");
  });

  it("passes an abort signal that fires on timeout", async () => {
    let aborted = false;
    const provider = new FakeProvider(
      (req) =>
        new Promise<string>((_resolve, reject) => {
          req.signal.addEventListener("abort", () => {
            aborted = true;
            reject(req.signal.reason);
          });
        }),
    );
    await expectCode(reviewer(provider, { timeoutMs: 50 }).review(makeInput()), "TIMEOUT");
    expect(aborted).toBe(true);
  });
});

describe("truncation", () => {
  it("finish_reason=length with unparsable output -> OUTPUT_TRUNCATED, no repair retry", async () => {
    const provider = new FakeProvider(() => ({ content: '{"main_assumptions": ["a", "b', finishReason: "length" }));
    await expectCode(reviewer(provider).review(makeInput()), "OUTPUT_TRUNCATED");
    expect(provider.requests).toHaveLength(1);
  });

  it("finish_reason=length but valid JSON is accepted", async () => {
    const provider = new FakeProvider((_r, i) => ({ content: JSON.stringify(i === 0 ? validPosition : validVerdict), finishReason: "length" }));
    const result = await reviewer(provider).review(makeInput());
    expect(result.verdict).toBe("MODIFY");
  });
});

describe("internal errors", () => {
  it("maps non-ReviewError exceptions to INTERNAL_ERROR", async () => {
    const provider = new FakeProvider(() => {
      throw new TypeError("boom");
    });
    await expectCode(reviewer(provider).review(makeInput()), "INTERNAL_ERROR");
  });
});

describe("token budget", () => {
  it("skips phase 2 when reported usage after phase 1 already reached the cap", async () => {
    const provider = new FakeProvider(() => ({
      content: JSON.stringify(validPosition),
      usage: { prompt_tokens: 1500, completion_tokens: 600, total_tokens: 2100 },
    }));
    // per-call clamp lets phase 1 run (budget 2000 > estimate), reported usage overshoots the cap
    const result = await reviewer(provider, { maxReviewTokens: 2000, maxTokensPerCall: 1000 }).review(makeInput());
    expect(provider.requests).toHaveLength(1);
    expect(result.meta.budget_exhausted).toBe(true);
    expect(result.verdict).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("does not attempt a repair retry once the budget is spent", async () => {
    const provider = new FakeProvider(() => ({ content: "nope", usage: { prompt_tokens: 2000, completion_tokens: 900, total_tokens: 2900 } }));
    await expectCode(reviewer(provider, { maxReviewTokens: 3000 }).review(makeInput()), "BUDGET_EXCEEDED");
    expect(provider.requests).toHaveLength(1);
  });

  it("phase 2 max_tokens is clamped to what is left", async () => {
    const provider = new FakeProvider((_r, i) => ({
      content: JSON.stringify(i === 0 ? validPosition : validVerdict),
      usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 },
    }));
    await reviewer(provider, { maxReviewTokens: 4000, maxTokensPerCall: 4000 }).review(makeInput());
    expect(provider.requests[1]!.maxTokens).toBeLessThan(2000);
  });

  it("clamps max_tokens to the remaining budget", async () => {
    const provider = FakeProvider.sequence(validPosition, validVerdict);
    await reviewer(provider, { maxReviewTokens: 3000, maxTokensPerCall: 4000 }).review(makeInput());
    expect(provider.requests[0]!.maxTokens).toBeLessThan(3000);
  });

  it("skips phase 2 with INSUFFICIENT_EVIDENCE when phase 1 exhausts the budget", async () => {
    const provider = new FakeProvider(() => ({
      content: JSON.stringify(validPosition),
      usage: { prompt_tokens: 2500, completion_tokens: 400, total_tokens: 2900 },
    }));
    const result = await reviewer(provider, { maxReviewTokens: 3000 }).review(makeInput());
    expect(provider.requests).toHaveLength(1);
    expect(result.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.confidence).toBe(0);
    expect(result.meta.budget_exhausted).toBe(true);
    expect(result.meta.phases).toBe(1);
  });

  it("raises BUDGET_EXCEEDED when even phase 1 does not fit", async () => {
    const provider = FakeProvider.sequence(validPosition);
    await expectCode(reviewer(provider, { maxReviewTokens: 300 }).review(makeInput()), "BUDGET_EXCEEDED");
    expect(provider.requests).toHaveLength(0);
  });
});

describe("provider errors propagate as typed errors", () => {
  it("propagates ReviewError codes from the provider", async () => {
    const provider = new FakeProvider(() => {
      throw new ReviewError("PROVIDER_HTTP_ERROR", "HTTP 503", { status: 503 });
    });
    await expectCode(reviewer(provider).review(makeInput()), "PROVIDER_HTTP_ERROR");
  });
});
