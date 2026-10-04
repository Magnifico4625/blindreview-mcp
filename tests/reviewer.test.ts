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

describe("recursion guard", () => {
  it("blocks a nested review_decision started from inside a review", async () => {
    let nestedError: unknown;
    const holder: { r?: Reviewer } = {};
    const provider = new FakeProvider(async (_req, i) => {
      if (i === 0) {
        try {
          await holder.r!.review(makeInput());
        } catch (e) {
          nestedError = e;
        }
      }
      return JSON.stringify(i === 0 ? validPosition : validVerdict);
    });
    holder.r = reviewer(provider);
    const result = await holder.r.review(makeInput());
    expect(result.verdict).toBe("MODIFY");
    expect(nestedError).toBeInstanceOf(ReviewError);
    expect((nestedError as ReviewError).code).toBe("RECURSION_BLOCKED");
    expect(provider.requests).toHaveLength(2); // the nested review made no provider call
  });

  it("allows independent sequential and concurrent top-level reviews", async () => {
    const provider = new FakeProvider((req) => JSON.stringify(req.messages.length > 2 ? validVerdict : validPosition));
    const r = reviewer(provider);
    await r.review(makeInput());
    const both = await Promise.all([r.review(makeInput()), r.review(makeInput())]);
    expect(both.map((b) => b.verdict)).toEqual(["MODIFY", "MODIFY"]);
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

  it("never executes tool calls and rejects answers that exceed MAX_TOOL_CALLS", async () => {
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

describe("token budget", () => {
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
