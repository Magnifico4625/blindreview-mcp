import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCases, toReviewInput } from "../benchmark/cases.js";
import { evaluateRun, keywordGroupsHit } from "../benchmark/evaluator.js";
import { fileTimestamp, runBenchmark, toMarkdown } from "../benchmark/runner.js";
import { rng, shuffle, spread, wilson } from "../benchmark/stats.js";
import { findProjectRoot } from "../src/config.js";
import { proposalContainment } from "../src/reviewer/blindness.js";
import type { ReviewResult } from "../src/schemas/review.js";
import { FakeProvider, allText, testConfig, validPosition, validVerdict } from "./helpers.js";

const casesDir = path.join(findProjectRoot(), "examples", "cases");

function fakeResult(verdict: ReviewResult["verdict"]): ReviewResult {
  return {
    ...(validVerdict as Omit<ReviewResult, "meta">),
    verdict,
    meta: { review_id: "x", review_mode: "blind_first", model: "m", phases: 2, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, latency_ms: 1 },
  };
}

describe("benchmark cases", () => {
  it("has 6 flawed cases and >= 5 sound controls with consistent labels", async () => {
    const cases = await loadCases(casesDir);
    expect(cases.filter((c) => c.has_hidden_flaw)).toHaveLength(6);
    const sound = cases.filter((c) => !c.has_hidden_flaw);
    expect(sound.length).toBeGreaterThanOrEqual(5);
    for (const c of sound) {
      expect(c.expected_verdict).toBe("KEEP");
      expect(c.acceptable_verdicts).not.toContain("REPLACE");
    }
    for (const c of cases.filter((x) => x.has_hidden_flaw)) expect(c.acceptable_verdicts).not.toContain("KEEP");
  });

  it("every case respects the blindness contract (proposal not copied into blind fields)", async () => {
    for (const c of await loadCases(casesDir)) expect(proposalContainment(toReviewInput(c, "blind_first"))).toBeLessThan(0.15);
  });
});

describe("benchmark runner", () => {
  it("runs 3 modes x N runs and never sends hidden_flaw / notes to the reviewer", async () => {
    const cases = await loadCases(casesDir);
    const provider = new FakeProvider((req) => JSON.stringify(req.messages.at(-1)!.content.includes('"verdict"') ? validVerdict : validPosition));
    const report = await runBenchmark(cases, testConfig, provider, { runs: 2, concurrency: 3 });
    // per case and run: 1 call proposal_first + 2 calls proposal_first_2pass + 2 calls blind_first
    expect(provider.requests.length).toBe(cases.length * 2 * 5);
    const sent = provider.requests.map(allText).join("\n");
    for (const c of cases) {
      if (c.hidden_flaw) expect(sent).not.toContain(c.hidden_flaw);
      if (c.notes) expect(sent).not.toContain(c.notes);
    }
    expect(report.summary.map((s) => s.mode)).toEqual(["proposal_first", "proposal_first_2pass", "blind_first"]);
    expect(report.cases.every((c) => c.runs.length === 2)).toBe(true);
    const bf = report.summary.find((s) => s.mode === "blind_first")!;
    expect(bf.errors).toBe(0);
    // fake always says MODIFY: acceptable on flawed cases, acceptable (not exact) on sound ones
    expect(bf.flawed.acceptable.rate).toBe(1);
    expect(bf.sound.exact_keep.rate).toBe(0);
    expect(bf.sound.false_alarm.rate).toBe(0);
    expect(toMarkdown(report)).toContain("## Summary per mode");
  });

  it("mode order is shuffled reproducibly by seed", async () => {
    const cases = (await loadCases(casesDir)).slice(0, 4);
    const provider = () => new FakeProvider((req) => JSON.stringify(req.messages.at(-1)!.content.includes('"verdict"') ? validVerdict : validPosition));
    const a = await runBenchmark(cases, testConfig, provider(), { runs: 2, seed: 7 });
    const b = await runBenchmark(cases, testConfig, provider(), { runs: 2, seed: 7 });
    const orders = (r: typeof a) => r.cases.flatMap((c) => c.runs.map((x) => x.mode_order.join(",")));
    expect(orders(a)).toEqual(orders(b));
    expect(new Set(orders(a)).size).toBeGreaterThan(1);
  });
});

describe("evaluator", () => {
  it("classifies exact / acceptable / under / over / false alarm", async () => {
    const cases = await loadCases(casesDir);
    const flawed = cases.find((c) => c.id === "coupon-double-redeem")!;
    const sound = cases.find((c) => c.id === "concurrent-index-sound")!;
    expect(evaluateRun(flawed, { ok: true, result: fakeResult("REPLACE") })).toMatchObject({ exact: true, acceptable: true, under: false, over: false });
    expect(evaluateRun(flawed, { ok: true, result: fakeResult("MODIFY") })).toMatchObject({ exact: false, acceptable: true, under: false });
    expect(evaluateRun(flawed, { ok: true, result: fakeResult("KEEP") })).toMatchObject({ acceptable: false, under: true, over: false, false_alarm: false });
    expect(evaluateRun(sound, { ok: true, result: fakeResult("REPLACE") })).toMatchObject({ acceptable: false, over: true, false_alarm: true });
    expect(evaluateRun(sound, { ok: true, result: fakeResult("INSUFFICIENT_EVIDENCE") })).toMatchObject({ abstain: true, under: false, over: false });
    expect(evaluateRun(sound, { ok: false, error: { code: "TIMEOUT", message: "t" }, latency_ms: 5 })).toMatchObject({ ok: false, error_code: "TIMEOUT" });
  });

  it("weak keyword heuristic", () => {
    expect(keywordGroupsHit("Revoked users keep STALE access", ["revo[ck]", "stale", "kafka"])).toEqual(["revo[ck]", "stale"]);
  });
});

describe("stats", () => {
  it("wilson interval", () => {
    const r = wilson(5, 10);
    expect(r.rate).toBe(0.5);
    expect(r.ci95![0]).toBeCloseTo(0.237, 2);
    expect(r.ci95![1]).toBeCloseTo(0.763, 2);
    expect(wilson(0, 0).rate).toBeNull();
  });

  it("spread and seeded shuffle", () => {
    expect(spread([1, 2, 3])).toMatchObject({ mean: 2, sd: 1, min: 1, max: 3 });
    expect(shuffle([1, 2, 3, 4], rng(1))).toEqual(shuffle([1, 2, 3, 4], rng(1)));
  });

  it("uses Windows-safe timestamps", () => {
    expect(fileTimestamp(new Date("2026-10-04T08:00:00.000Z"))).toBe("2026-10-04T08-00-00-000Z");
  });
});
