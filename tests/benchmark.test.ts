import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCases, toReviewInput } from "../benchmark/cases.js";
import { evaluateRun, keywordGroupsHit } from "../benchmark/evaluator.js";
import { fileTimestamp, runBenchmark, toMarkdown } from "../benchmark/runner.js";
import { findProjectRoot } from "../src/config.js";
import { FakeProvider, allText, testConfig, validPosition, validVerdict } from "./helpers.js";

const casesDir = path.join(findProjectRoot(), "examples", "cases");

describe("benchmark", () => {
  it("loads >= 5 valid cases, several with hidden flaws", async () => {
    const cases = await loadCases(casesDir);
    expect(cases.length).toBeGreaterThanOrEqual(5);
    expect(cases.filter((c) => c.has_hidden_flaw).length).toBeGreaterThanOrEqual(4);
  });

  it("never sends hidden_flaw / notes / keywords to the reviewer", async () => {
    const cases = await loadCases(casesDir);
    const provider = new FakeProvider((req) => JSON.stringify(req.messages.at(-1)!.content.includes("\"verdict\"") ? validVerdict : validPosition));
    const report = await runBenchmark(cases, testConfig, provider);
    expect(provider.requests.length).toBe(cases.length * 3); // 1 call proposal_first + 2 calls blind_first
    const sent = provider.requests.map(allText).join("\n");
    for (const c of cases) {
      if (c.hidden_flaw) expect(sent).not.toContain(c.hidden_flaw);
      if (c.notes) expect(sent).not.toContain(c.notes);
    }
    for (const c of cases) expect(Object.keys(toReviewInput(c, "blind_first"))).not.toContain("hidden_flaw");
    expect(report.summary.map((s) => s.mode)).toEqual(["proposal_first", "blind_first"]);
    expect(toMarkdown(report)).toContain("| mode |");
  });

  it("computes mechanical keyword stats", async () => {
    expect(keywordGroupsHit("Revoked users keep STALE access", ["revoc|revok", "stale", "kafka"])).toEqual(["revoc|revok", "stale"]);
    const [c] = await loadCases(casesDir);
    const e = evaluateRun(c!, { ok: false, error: { code: "TIMEOUT", message: "t" }, latency_ms: 5 });
    expect(e).toMatchObject({ ok: false, verdict: null, error_code: "TIMEOUT" });
  });

  it("uses Windows-safe timestamps", () => {
    expect(fileTimestamp(new Date("2026-10-04T08:00:00.000Z"))).toBe("2026-10-04T08-00-00-000Z");
  });
});
