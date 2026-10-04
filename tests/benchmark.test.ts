import path from "node:path";
import { describe, expect, it } from "vitest";
import { isFlawed, loadCases, toReviewInput, type BenchmarkCase } from "../benchmark/cases.js";
import { exportSheet, ingestSheet, parseCsv } from "../benchmark/human-review.js";
import { computeModeMetrics, type RunRecord } from "../benchmark/metrics.js";
import { toExperimentMarkdown, toMarkdown } from "../benchmark/report.js";
import { DEFAULT_MODES, fileTimestamp, runBenchmark } from "../benchmark/runner.js";
import { pairedBootstrapDiff, rng, shuffle, spread, wilson } from "../benchmark/stats.js";
import { signalLabel } from "../benchmark/thresholds.js";
import { findProjectRoot } from "../src/config.js";
import { proposalContainment } from "../src/reviewer/blindness.js";
import { ReviewError, type ReviewResult, type Verdict } from "../src/schemas/review.js";
import { FakeProvider, SENTINEL, allText, testConfig, validPosition, validVerdict } from "./helpers.js";

const casesDir = path.join(findProjectRoot(), "benchmark", "cases");
const answer = (verdict: Verdict = "MODIFY") =>
  new FakeProvider((req) => JSON.stringify(req.messages.at(-1)!.content.includes('"verdict"') ? { ...validVerdict, verdict } : validPosition));

function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collectStrings(x, out));
  return out;
}

const fakeResult = (verdict: Verdict, tokens = 100): ReviewResult => ({
  ...(validVerdict as Omit<ReviewResult, "meta">),
  verdict,
  meta: { review_id: "x", review_mode: "blind_first", model: "m", phases: 2, usage: { prompt_tokens: tokens / 2, completion_tokens: tokens / 2, total_tokens: tokens }, latency_ms: 10 },
});
const rec = (case_id: string, mode: RunRecord["mode"], run: number, verdict: Verdict | null): RunRecord => ({
  case_id,
  run,
  mode,
  attempts: 1,
  retries: [],
  ok: verdict !== null,
  ...(verdict ? { result: fakeResult(verdict) } : { error: { code: "TIMEOUT", message: "t" } }),
  usage_all_attempts: { prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 },
  latency_ms: 10,
});

describe("benchmark cases", () => {
  it(">= 20 cases, roughly half flawed, ground truth consistent", async () => {
    const { cases, hash } = await loadCases(casesDir);
    expect(cases.length).toBeGreaterThanOrEqual(20);
    const flawed = cases.filter(isFlawed).length;
    expect(flawed / cases.length).toBeGreaterThan(0.4);
    expect(flawed / cases.length).toBeLessThan(0.6);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    for (const c of cases) {
      if (c.ground_truth.proposal_status === "correct") expect(c.ground_truth.acceptable_verdicts).toEqual(["KEEP"]);
      if (isFlawed(c)) expect(c.ground_truth.required_observations.length).toBeGreaterThan(0);
      if (c.source.type !== "synthetic") expect(c.source.url).toMatch(/^https:\/\//);
    }
  });

  it("every case respects the blindness contract (overlap below the warn threshold)", async () => {
    for (const c of (await loadCases(casesDir)).cases) expect(proposalContainment(toReviewInput(c)), c.id).toBeLessThan(0.15);
  });
});

describe("no ground truth reaches the reviewer", () => {
  it("no source/ground_truth/diagnostics text (incl. sentinel) in any request for any mode/case", async () => {
    const { cases } = await loadCases(casesDir);
    const poisoned: BenchmarkCase[] = cases.map((c) => ({
      ...c,
      source: { ...c.source, note: `${c.source.note} ${SENTINEL}` },
      ground_truth: { ...c.ground_truth, material_issue: `${c.ground_truth.material_issue} ${SENTINEL}`, notes: SENTINEL, required_observations: [...c.ground_truth.required_observations, SENTINEL] },
      diagnostics: { hidden_flaw_keywords: [SENTINEL] },
    }));
    const provider = answer();
    await runBenchmark(poisoned, testConfig, { label: "t", runs: 1, caseSetHash: "x", provider, concurrency: 4 });
    const sent = provider.requests.map(allText).join("\n");
    expect(sent).not.toContain(SENTINEL);
    for (const c of cases) {
      for (const s of collectStrings([c.source, c.ground_truth, c.diagnostics]).filter((x) => x.length >= 25)) expect(sent, `${c.id}: ${s.slice(0, 40)}`).not.toContain(s);
    }
  });
});

describe("benchmark-only modes", () => {
  it("independent_only: reviewer never sees the proposal; comparer is a fresh session without the problem statement", async () => {
    const { cases } = await loadCases(casesDir);
    const c = cases[0]!;
    const marked: BenchmarkCase = { ...c, input: { ...c.input, proposed_solution: `${c.input.proposed_solution} ${SENTINEL}` } };
    const provider = answer();
    await runBenchmark([marked], testConfig, { label: "t", modes: ["independent_only"], runs: 1, caseSetHash: "x", provider });
    expect(provider.requests).toHaveLength(2);
    const [phase1, comparer] = provider.requests;
    expect(allText(phase1!)).not.toContain(SENTINEL);
    expect(allText(phase1!)).not.toContain(c.input.proposed_solution);
    expect(allText(comparer!)).toContain(SENTINEL);
    expect(allText(comparer!)).toContain(validPosition.preferred_solution);
    expect(allText(comparer!)).not.toContain(c.input.context);
    expect(allText(comparer!)).not.toContain(c.input.objective);
    expect(comparer!.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("decision_judge: single call with the proposal and the anti critic-bias instruction", async () => {
    const { cases } = await loadCases(casesDir);
    const provider = answer();
    await runBenchmark([cases[0]!], testConfig, { label: "t", modes: ["decision_judge"], runs: 1, caseSetHash: "x", provider });
    expect(provider.requests).toHaveLength(1);
    expect(allText(provider.requests[0]!)).toContain(cases[0]!.input.proposed_solution);
    expect(allText(provider.requests[0]!)).toMatch(/Preserving a correct proposal is equally valuable/);
  });
});

describe("runner", () => {
  it("runs all modes x runs, records metadata, renders reports", async () => {
    const { cases } = await loadCases(casesDir);
    const subset = cases.slice(0, 6);
    const report = await runBenchmark(subset, testConfig, { label: "unit", runs: 2, caseSetHash: "abc", provider: answer(), concurrency: 3 });
    expect(report.records).toHaveLength(subset.length * 2 * DEFAULT_MODES.length);
    expect(report.metrics.map((m) => m.mode)).toEqual([...DEFAULT_MODES]);
    expect(report.comparisons.map((c) => c.question)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(report.prompt_hashes.blind_first).toMatch(/^[0-9a-f]{16}$/);
    expect(report).toMatchObject({ label: "unit", case_set_hash: "abc", model: "fake-model", base_url_host: "fake.local" });
    expect(report.git).toHaveProperty("sha");
    const md = toMarkdown(report);
    expect(md).toContain("| Mode | Decision accuracy | Decision accuracy (strict) | Correct KEEP | Defect detection | Exact verdict | False intervention | Severe false intervention | Avg tokens | Avg latency |");
    for (const s of ["## Correct proposals", "## Flawed proposals", "## Cost", "## Failures", "Q1", "Q2", "Q3", "## Experiment: decision_judge"]) expect(md).toContain(s);
    expect(toExperimentMarkdown(report)).toContain("Q4");
  });

  it("retries transient errors, logs them, and never drops failed runs", async () => {
    const { cases } = await loadCases(casesDir);
    let calls = 0;
    const flaky = new FakeProvider(() => {
      calls++;
      if (calls === 1) throw new ReviewError("TIMEOUT", "slow");
      if (calls === 2) throw new ReviewError("PROVIDER_HTTP_ERROR", "bad request", { status: 400 });
      return JSON.stringify(validVerdict);
    });
    const report = await runBenchmark([cases[0]!], testConfig, { label: "t", modes: ["proposal_first"], runs: 2, caseSetHash: "x", provider: flaky, retryDelayMs: 1 });
    const [r1, r2] = report.records;
    expect(r1).toMatchObject({ ok: false, attempts: 2, error: { code: "PROVIDER_HTTP_ERROR" } });
    expect(r1!.retries).toEqual([{ code: "TIMEOUT", message: "slow" }]);
    expect(r2).toMatchObject({ ok: true, attempts: 1 });
    const m = report.metrics[0]!;
    expect(m).toMatchObject({ expected: 2, successful: 1, failed: 1, failure_reasons: { PROVIDER_HTTP_ERROR: 1 }, retried_runs: 1 });
  });

  it("checkpoints every record and resumes without re-running finished ones", async () => {
    const { cases } = await loadCases(casesDir);
    const subset = cases.slice(0, 3);
    const saved: RunRecord[] = [];
    const full = await runBenchmark(subset, testConfig, { label: "t", runs: 2, caseSetHash: "x", provider: answer(), onRecord: (r) => void saved.push(r) });
    expect(saved).toHaveLength(full.records.length);
    const provider = answer();
    const resumed = await runBenchmark(subset, testConfig, { label: "t", runs: 2, caseSetHash: "x", provider, resumeRecords: saved.slice(0, 10) });
    expect(resumed.records).toHaveLength(full.records.length);
    const calls = (m: string) => ({ proposal_first: 1, decision_judge: 1 })[m] ?? 2;
    expect(provider.requests).toHaveLength(full.records.slice(0).reduce((n, r) => n + calls(r.mode), 0) - saved.slice(0, 10).reduce((n, r) => n + calls(r.mode), 0));
  });

  it("mode order is shuffled reproducibly", async () => {
    const { cases } = await loadCases(casesDir);
    const orders = async () => {
      const lines: string[] = [];
      await runBenchmark(cases.slice(0, 4), testConfig, { label: "t", runs: 2, seed: 7, caseSetHash: "x", provider: answer(), log: (l) => lines.push(l) });
      return lines.map((l) => l.replace(/ \d+ms/, ""));
    };
    expect(await orders()).toEqual(await orders());
  });
});

describe("metrics definitions", () => {
  it("computes accuracy, KEEP accuracy, detection, interventions, strict variants", async () => {
    const { cases } = await loadCases(casesDir);
    const correct = cases.find((c) => c.ground_truth.proposal_status === "correct")!;
    const fund = cases.find((c) => c.ground_truth.proposal_status === "fundamentally_flawed")!;
    const records = [
      rec(correct.id, "blind_first", 1, "KEEP"),
      rec(correct.id, "blind_first", 2, "MODIFY"),
      rec(correct.id, "blind_first", 3, "REPLACE"),
      rec(fund.id, "blind_first", 1, "REPLACE"),
      rec(fund.id, "blind_first", 2, "MODIFY"),
      rec(fund.id, "blind_first", 3, null),
    ];
    const m = computeModeMetrics("blind_first", cases, records);
    expect(m).toMatchObject({ expected: 6, successful: 5, failed: 1, failure_reasons: { TIMEOUT: 1 } });
    expect(m.decision_accuracy).toMatchObject({ k: 3, n: 5 });
    expect(m.decision_accuracy_strict).toMatchObject({ k: 3, n: 6 });
    expect(m.keep_accuracy_correct).toMatchObject({ k: 1, n: 3 });
    expect(m.false_intervention).toMatchObject({ k: 1, n: 3 });
    expect(m.severe_false_intervention).toMatchObject({ k: 1, n: 3 });
    expect(m.defect_detection).toMatchObject({ k: 2, n: 2 });
    expect(m.defect_detection_strict).toMatchObject({ k: 2, n: 3 });
    expect(m.exact).toMatchObject({ k: 2, n: 5 }); // KEEP on correct + REPLACE on fundamentally flawed
  });
});

describe("stats and pre-registered labels", () => {
  it("wilson, spread, seeded shuffle, timestamps", () => {
    const r = wilson(5, 10);
    expect(r.ci95![0]).toBeCloseTo(0.237, 2);
    expect(spread([1, 2, 3])).toMatchObject({ mean: 2, sd: 1 });
    expect(shuffle([1, 2, 3, 4], rng(1))).toEqual(shuffle([1, 2, 3, 4], rng(1)));
    expect(fileTimestamp(new Date("2026-10-04T08:00:00.000Z"))).toBe("2026-10-04T08-00-00-000Z");
  });

  it("paired bootstrap difference", () => {
    const a = Array.from({ length: 20 }, () => [1, 1, 1] as Array<0 | 1>);
    const b = Array.from({ length: 20 }, (_, i) => (i < 10 ? [1, 1, 1] : [0, 0, 0]) as Array<0 | 1>);
    const d = pairedBootstrapDiff(a, b, { seed: 1, iterations: 2000 });
    expect(d.diff).toBe(0.5);
    expect(d.ci95![0]).toBeGreaterThan(0.2);
    expect(pairedBootstrapDiff(b, b).diff).toBe(0);
  });

  it("labels follow the pre-registered thresholds", () => {
    const L = (diff: number, lo: number, hi: number) => signalLabel({ diff, ci95: [lo, hi], method: "", clusters: 20 });
    expect(L(0.12, 0.01, 0.2)).toBe("clear signal");
    expect(L(0.12, -0.02, 0.2)).toBe("weak signal");
    expect(L(0.06, -0.04, 0.15)).toBe("weak signal");
    expect(L(0.06, -0.08, 0.15)).toBe("inconclusive");
    expect(L(0.03, -0.05, 0.1)).toBe("inconclusive");
    expect(L(0, -0.1, 0.1)).toBe("no observed advantage");
    expect(L(-0.1, -0.2, 0)).toBe("no observed advantage");
  });
});

describe("human review sheet", () => {
  it("exports a mode-blinded sheet and ingests a filled one (CRLF-safe, quotes, no LLM)", async () => {
    const { cases } = await loadCases(casesDir);
    const flawed = cases.find((c) => isFlawed(c))!;
    const records = [rec(flawed.id, "blind_first", 1, "REPLACE"), rec(flawed.id, "proposal_first", 1, "MODIFY")];
    const { csv, key } = exportSheet("lbl", cases, records);
    const rows = parseCsv(csv);
    expect(rows[0]).toContain("hit");
    expect(rows[0]).not.toContain("mode");
    expect(rows.length - 1).toBe(2 * flawed.ground_truth.required_observations.length);
    const head = rows[0]!;
    const filled = [head, ...rows.slice(1).map((r) => r.map((v, i) => (head[i] === "hit" ? (key.items[r[0]!]!.mode === "blind_first" ? "yes" : "no") : v)))]
      .map((r) => r.map((v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(","))
      .join("\r\n");
    const cov = ingestSheet(filled, key);
    const bf = cov.find((c) => c.mode === "blind_first")!;
    const pf = cov.find((c) => c.mode === "proposal_first")!;
    expect(bf.hit.rate).toBe(1);
    expect(bf.all_hit).toMatchObject({ k: 1, n: 1 });
    expect(pf.hit.rate).toBe(0);
    expect(() => ingestSheet(filled.replace(/,yes(\r?\n|$)/, ",maybe$1"), key)).toThrow(/yes\/no/);
  });
});
