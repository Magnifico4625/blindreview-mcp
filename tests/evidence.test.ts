import { mkdtemp, rm, symlink, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { changedLinesOf, extractDiff, isRepoCorrect, isTestableDefect, isUntestableDefect, loadRepoCases, toBaselineInput, toRepoView, type RepoCase } from "../benchmark/evidence/cases.js";
import { CostMeter, SpendLedger } from "../benchmark/evidence/cost.js";
import { criterionLabel, projectVerdict } from "../benchmark/evidence/criteria.js";
import { computeRepoMetrics } from "../benchmark/evidence/metrics.js";
import { repoMarkdown } from "../benchmark/evidence/report.js";
import { BudgetStop, runRepoBenchmark, type RepoRunRecord } from "../benchmark/evidence/runner.js";
import { wilson } from "../benchmark/stats.js";
import { findProjectRoot } from "../src/config.js";
import { applyGate, changedLinesFromDiff, type GateAnswer, type ToolLogEntry } from "../src/evidence/gate.js";
import { runEvidenceGate } from "../src/evidence/judge.js";
import { BUDGET_EXHAUSTED_MESSAGE } from "../src/evidence/prompts.js";
import { childEnv, RepoSandbox } from "../src/evidence/sandbox.js";
import type { ToolChatProvider, ToolChatRequest, ToolChatResponse } from "../src/evidence/tool-provider.js";
import { FakeProvider, SENTINEL, testConfig, validVerdict } from "./helpers.js";

const casesDir = path.join(findProjectRoot(), "benchmark", "repo-cases");

/** Scripted tool-calling provider. */
class FakeToolProvider implements ToolChatProvider {
  readonly model = "fake-tool-model";
  readonly requests: ToolChatRequest[] = [];
  constructor(private readonly script: (req: ToolChatRequest, i: number) => Partial<ToolChatResponse>) {}
  async chat(req: ToolChatRequest): Promise<ToolChatResponse> {
    const i = this.requests.length;
    this.requests.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) });
    const r = this.script(req, i);
    return { content: r.content ?? "", toolCalls: r.toolCalls ?? [], usage: r.usage ?? { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 }, costUsd: r.costUsd === undefined ? 0.0002 : r.costUsd, model: this.model };
  }
}
const call = (name: string, args: Record<string, unknown> = {}, id = `c${Math.random()}`) => ({ id, name, arguments: JSON.stringify(args) });
const final = (a: unknown) => ({ content: JSON.stringify(a) });
const keepAnswer = { decision: "KEEP", summary: "fine", claim: null };
const claimAnswer = (over: Record<string, unknown>) => ({ decision: "CLAIM", summary: "s", claim: { claim: "c", severity: "high", evidence_needed: "e", verification: "v", evidence_refs: [], result: "confirmed", verdict: "MODIFY", ...over } });

async function caseById(id: string): Promise<RepoCase> {
  const c = (await loadRepoCases(casesDir)).cases.find((x) => x.id === id);
  if (!c) throw new Error(id);
  return c;
}

describe("repo-snapshot cases", () => {
  it("15-20 cases: ~half confirmable defects, ~half correct, 2-3 untestable defects", async () => {
    const { cases, hash } = await loadRepoCases(casesDir);
    expect(cases.length).toBeGreaterThanOrEqual(15);
    expect(cases.length).toBeLessThanOrEqual(20);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    const testable = cases.filter(isTestableDefect).length;
    const correct = cases.filter(isRepoCorrect).length;
    const untestable = cases.filter(isUntestableDefect).length;
    expect(untestable).toBeGreaterThanOrEqual(2);
    expect(untestable).toBeLessThanOrEqual(3);
    expect(Math.abs(testable - correct)).toBeLessThanOrEqual(2);
    for (const k of ["test", "typecheck", "search"]) expect(cases.some((c) => c.ground_truth.defect_kind === k), k).toBe(true);
    for (const c of cases) {
      expect(extractDiff(c.input.proposed_solution).length, c.id).toBeGreaterThan(50);
      if (isRepoCorrect(c)) expect(c.ground_truth.acceptable_verdicts).toEqual(["KEEP"]);
    }
  });

  it("ground truth is outside the snapshot and its text appears in no snapshot file", async () => {
    const { cases } = await loadRepoCases(casesDir);
    for (const c of cases) {
      const sb = await RepoSandbox.open(c.repoDir);
      expect(sb.listFiles()).not.toContain("case.json");
      const all = (await Promise.all(sb.listFiles().map((f) => readFile(path.join(c.repoDir, f), "utf8")))).join("\n");
      for (const s of [c.ground_truth.material_issue, c.ground_truth.notes, ...c.ground_truth.required_observations].filter((x) => x.length >= 25)) expect(all, c.id).not.toContain(s);
      await expect(sb.readFile({ path: "../case.json" })).rejects.toThrow(/escapes/);
    }
  });

  it("snapshots behave as labelled: test defects fail a test, typecheck defects fail tsc, everything else is green", async () => {
    const { cases } = await loadRepoCases(casesDir);
    for (const c of cases) {
      const sb = await RepoSandbox.open(c.repoDir);
      try {
        const failing = [];
        for (const t of sb.testAllowlist()) failing.push(...(await sb.runTest({ test_file: t })).artifacts);
        const tc = await sb.typecheck();
        const kind = c.ground_truth.defect_kind;
        expect(failing.length > 0, `${c.id} failing tests`).toBe(kind === "test");
        expect(tc.artifacts.length > 0, `${c.id} typecheck errors: ${tc.text.slice(0, 200)}`).toBe(kind === "typecheck");
      } finally {
        await sb.dispose();
      }
    }
  }, 180_000);
});

describe("sandbox", () => {
  it("rejects absolute paths, traversal and symlink escapes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sbx-"));
    await writeFile(path.join(dir, "a.js"), "export const a = 1;\n");
    await symlink(os.tmpdir(), path.join(dir, "link"));
    const sb = await RepoSandbox.open(dir);
    await expect(sb.readFile({ path: "/etc/passwd" })).rejects.toThrow(/absolute/);
    await expect(sb.readFile({ path: "../x" })).rejects.toThrow(/escapes/);
    await expect(sb.readFile({ path: "link/whatever" })).rejects.toThrow(/escapes/);
    expect((await sb.readFile({ path: "a.js" })).text).toContain("export const a = 1;");
    await rm(dir, { recursive: true, force: true });
  });

  it("run_test only accepts allowlisted test files; child env carries no API key", async () => {
    const c = await caseById("retry-jitter");
    const sb = await RepoSandbox.open(c.repoDir);
    expect(sb.testAllowlist()).toEqual(["test/retry.test.js"]);
    expect((await sb.runTest({ test_file: "src/retry.js" })).text).toMatch(/allowlist/);
    expect((await sb.runTest({ test_file: "--eval=process.exit(1)" })).ok).toBe(false);
    const r = await sb.runTest({ test_file: "test/retry.test.js" });
    expect(r.artifacts.map((a) => a.detail)).toEqual(["makes exactly `attempts` calls when every call fails"]);
    await sb.dispose();
    process.env.REVIEWER_API_KEY_TEST_PROBE = "x";
    const env = childEnv();
    expect(Object.keys(env).some((k) => /KEY|TOKEN|SECRET/i.test(k))).toBe(false);
    delete process.env.REVIEWER_API_KEY_TEST_PROBE;
  });

  it("search and find_symbol return file:line artifacts; tool output is capped", async () => {
    const c = await caseById("drop-legacy-id-column");
    const sb = await RepoSandbox.open(c.repoDir);
    const s = await sb.search({ pattern: "legacy_id" });
    expect(s.artifacts.some((a) => a.file === "src/reports/partner-export.js")).toBe(true);
    const f = await sb.findSymbol({ name: "partnerExport" });
    expect(f.text).toMatch(/\[definition\] src\/reports\/partner-export\.js:\d+/);
    expect((await sb.search({ pattern: "(" })).ok).toBe(false);
    expect(s.text.length).toBeLessThanOrEqual(sb.limits.maxOutputChars + 60);
  });
});

describe("gate (harness-side validation)", () => {
  const diff = "--- a/src/x.js\n+++ b/src/x.js\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n+C\n d\n";
  const changed = changedLinesFromDiff(diff);
  const log = (artifacts: ToolLogEntry["artifacts"], id = "T1", tool = "search"): ToolLogEntry => ({ id, tool, args: {}, ok: true, artifacts, output_chars: 1, ms: 1 });
  const ans = (over: Record<string, unknown>) => claimAnswer(over) as GateAnswer;

  it("parses changed lines from a unified diff", () => {
    expect([...(changed.get("src/x.js") ?? [])]).toEqual([2, 3]);
  });

  it("KEEP has nothing to validate", () => {
    expect(applyGate(keepAnswer as GateAnswer, [], changed)).toMatchObject({ final_verdict: "KEEP", status: "no_claim" });
  });

  it("confirmed + cited failing test keeps MODIFY", () => {
    const g = applyGate(ans({ evidence_refs: ["T1"] }), [log([{ type: "failing_test", file: "test/a.test.js", detail: "x" }], "T1", "run_test")], changed);
    expect(g).toMatchObject({ status: "validated", final_verdict: "MODIFY", verdict_forced: false });
  });

  it("confirmed without citations is downgraded and MODIFY becomes WARNING", () => {
    const g = applyGate(ans({}), [log([{ type: "failing_test", file: "t", detail: "x" }])], changed);
    expect(g).toMatchObject({ status: "downgraded", final_result: "not_confirmed", final_verdict: "WARNING", verdict_forced: true });
  });

  it("citing a tool call without artifacts (or a nonexistent one) is downgraded", () => {
    expect(applyGate(ans({ evidence_refs: ["T1", "T9"] }), [log([], "T1", "run_test")], changed).status).toBe("downgraded");
  });

  it("a search hit on the proposal's own added lines does not qualify; one elsewhere does", () => {
    const own = log([{ type: "search_hit", file: "src/x.js", line: 3, detail: "C" }]);
    expect(applyGate(ans({ evidence_refs: ["T1", "src/x.js:3"] }), [own], changed).status).toBe("downgraded");
    const other = log([{ type: "search_hit", file: "src/y.js", line: 7, detail: "uses old" }]);
    expect(applyGate(ans({ evidence_refs: ["src/y.js:7"] }), [other], changed).status).toBe("validated");
    // location cited that the search never returned
    expect(applyGate(ans({ evidence_refs: ["src/y.js:8"] }), [other], changed).status).toBe("downgraded");
  });

  it("typecheck errors qualify anywhere; unable_to_verify / not_confirmed never allow MODIFY or REPLACE", () => {
    const tc = log([{ type: "typecheck_error", file: "src/x.js", line: 2, detail: "TS2339" }], "T1", "typecheck");
    expect(applyGate(ans({ evidence_refs: ["T1"], verdict: "REPLACE" }), [tc], changed).final_verdict).toBe("REPLACE");
    expect(applyGate(ans({ evidence_refs: ["T1"], result: "unable_to_verify", verdict: "MODIFY" }), [tc], changed)).toMatchObject({ final_verdict: "WARNING", status: "not_claimed_confirmed" });
    expect(applyGate(ans({ result: "not_confirmed", verdict: "KEEP" }), [], changed).final_verdict).toBe("KEEP");
    expect(applyGate(ans({ result: "unable_to_verify", verdict: "WARNING" }), [], changed).final_verdict).toBe("WARNING");
  });
});

describe("evidence_gate loop", () => {
  const open = async (id: string) => {
    const c = await caseById(id);
    const sb = await RepoSandbox.open(c.repoDir);
    return { c, sb, view: toRepoView(c, sb.listFiles(), sb.testAllowlist()), changed: changedLinesOf(c) };
  };

  it("executes tools, numbers them T1.., and validates a cited failing test", async () => {
    const { sb, view, changed } = await open("retry-jitter");
    const p = new FakeToolProvider((_r, i) => (i === 0 ? { toolCalls: [call("run_test", { test_file: "test/retry.test.js" })] } : final(claimAnswer({ evidence_refs: ["T1"] }))));
    const res = await runEvidenceGate({ provider: p, sandbox: sb, view, changed });
    await sb.dispose();
    expect(res.tool_log.map((t) => t.id)).toEqual(["T1"]);
    expect(res.gate.status).toBe("validated");
    expect(res.verdict).toBe("MODIFY");
    const toolMsg = p.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg && "content" in toolMsg ? toolMsg.content : "").toMatch(/^\[T1\] run_test test\/retry\.test\.js: exit 1/);
    expect(res.meta.cost_usd).toBeCloseTo(0.0004);
  });

  it("enforces the tool-call cap and then forces a final answer without tools", async () => {
    const { sb, view, changed } = await open("retry-jitter");
    const p = new FakeToolProvider((req) => (req.toolChoice === "auto" ? { toolCalls: [call("search", { pattern: "retry" }), call("search", { pattern: "x" })] } : final(keepAnswer)));
    const res = await runEvidenceGate({ provider: p, sandbox: sb, view, changed, limits: { maxToolCalls: 3 } });
    await sb.dispose();
    expect(res.tool_log).toHaveLength(3);
    expect(res.tool_calls_rejected).toBe(1);
    expect(res.meta.forced_final).toBe(true);
    expect(p.requests.at(-1)?.toolChoice).toBe("none");
    expect(JSON.stringify(p.requests.at(-1)?.messages)).toContain(BUDGET_EXHAUSTED_MESSAGE);
    expect(res.verdict).toBe("KEEP");
  });

  it("claimed-confirmed MODIFY with no tool evidence ends as WARNING", async () => {
    const { sb, view, changed } = await open("csv-rfc4180-quoting");
    const p = new FakeToolProvider(() => final(claimAnswer({ evidence_refs: ["src/csv.js:9"] })));
    const res = await runEvidenceGate({ provider: p, sandbox: sb, view, changed });
    expect(res).toMatchObject({ verdict: "WARNING", gate: { status: "downgraded", model_verdict: "MODIFY" } });
  });

  it("one repair retry for malformed output, then MALFORMED_RESPONSE", async () => {
    const { sb, view, changed } = await open("csv-rfc4180-quoting");
    const ok = await runEvidenceGate({ provider: new FakeToolProvider((_r, i) => (i === 0 ? { content: "I think it's fine" } : final(keepAnswer))), sandbox: sb, view, changed });
    expect(ok.meta.repaired).toBe(true);
    await expect(runEvidenceGate({ provider: new FakeToolProvider(() => ({ content: "nope" })), sandbox: sb, view, changed })).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("no ground-truth text reaches the model even when every file is read and every tool is called", async () => {
    const { cases } = await loadRepoCases(casesDir);
    for (const c0 of cases) {
      const c: RepoCase = { ...c0, ground_truth: { ...c0.ground_truth, material_issue: `${c0.ground_truth.material_issue} ${SENTINEL}`, notes: SENTINEL } };
      const sb = await RepoSandbox.open(c.repoDir);
      const calls = [...sb.listFiles().map((f) => call("read_file", { path: f })), call("search", { pattern: "." }), call("inspect_config"), call("typecheck"), call("read_file", { path: "../case.json" })];
      const p = new FakeToolProvider((_r, i) => (i === 0 ? { toolCalls: calls } : final(keepAnswer)));
      await runEvidenceGate({ provider: p, sandbox: sb, view: toRepoView(c, sb.listFiles(), sb.testAllowlist()), changed: changedLinesOf(c), limits: { maxToolCalls: 100 } });
      await sb.dispose();
      const sent = JSON.stringify(p.requests);
      expect(sent).not.toContain(SENTINEL);
      for (const s of [c0.ground_truth.material_issue, ...c0.ground_truth.required_observations].filter((x) => x.length >= 25)) expect(sent, c.id).not.toContain(s);
      expect(JSON.stringify(toBaselineInput(c, sb.listFiles(), sb.testAllowlist()))).not.toContain(SENTINEL);
    }
  }, 120_000);
});

describe("runner, budget and metrics", () => {
  const pricing = { prompt: 0.15e-6, completion: 0.5e-6 };
  const factory = (verdict = "KEEP") => ({
    tool: () => new FakeToolProvider(() => final(keepAnswer)),
    text: (meter: CostMeter) => {
      const fp = new FakeProvider(() => ({ content: JSON.stringify({ ...validVerdict, verdict }) }));
      return { name: "fake", model: "fake", complete: async (req: Parameters<FakeProvider["complete"]>[0]) => { const r = await fp.complete(req); meter.add({ ...r.usage, cost: 0.0001 }); return r; } };
    },
  });

  it("runs both modes, records cost in the ledger, stops at the hard cap and resumes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ledger-"));
    const { cases } = await loadRepoCases(casesDir);
    const sub = cases.filter((c) => ["csv-rfc4180-quoting", "retry-jitter"].includes(c.id));
    const ledger = new SpendLedger(path.join(dir, "spend.jsonl"));
    await ledger.load();
    const base = { label: "t", model: "fake", modes: ["evidence_gate", "decision_judge"] as const, runs: 1, seed: 1, concurrency: 1, retries: 0, caseSetHash: "x", providers: factory("MODIFY"), pricing, ledger, reservePerReviewUsd: { evidence_gate: 0.0001, decision_judge: 0.0001, proposal_first: 0.0001 } };
    const kept: RepoRunRecord[] = [];
    await expect(runRepoBenchmark(sub, testConfig, { ...base, hardStopUsd: 0.00025, onRecord: (r) => void kept.push(r) })).rejects.toBeInstanceOf(BudgetStop);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(4);
    const report = await runRepoBenchmark(sub, testConfig, { ...base, hardStopUsd: 1, resumeRecords: kept });
    expect(report.records).toHaveLength(4);
    expect(ledger.spent).toBeGreaterThan(0);
    const reloaded = new SpendLedger(path.join(dir, "spend.jsonl"));
    expect(await reloaded.load()).toBeCloseTo(ledger.spent);
    const eg = computeRepoMetrics("evidence_gate", sub, report.records);
    expect(eg.false_intervention).toMatchObject({ k: 0, n: 1 });
    expect(eg.recall_testable).toMatchObject({ k: 0, n: 1 });
    const dj = computeRepoMetrics("decision_judge", sub, report.records);
    expect(dj.false_intervention).toMatchObject({ k: 1, n: 1 });
    expect(repoMarkdown(report, sub)).toContain("## evidence_gate: what the harness gate did");
    await rm(dir, { recursive: true, force: true });
  });

  it("pre-registered criterion labels", () => {
    expect(criterionLabel(wilson(19, 20), wilson(3, 20), 0)).toBe("continue");
    expect(criterionLabel(wilson(18, 20), wilson(4, 20), 0)).toBe("continue");
    expect(criterionLabel(wilson(17, 20), wilson(2, 20), 0)).toBe("inconclusive");
    expect(criterionLabel(wilson(20, 20), wilson(8, 20), 0)).toBe("archive");
    expect(criterionLabel(wilson(20, 20), wilson(0, 20), 0.2)).toBe("inconclusive (failures)");
    expect(projectVerdict(["continue", "continue"])).toBe("continue");
    expect(projectVerdict(["continue", "archive"])).toBe("inconclusive");
    expect(projectVerdict(["archive", "archive"])).toBe("archive");
  });
});

describe("pilot fixes", () => {
  it("normalizes a flattened claim (claim as string + top-level fields)", async () => {
    const { normalizeGateAnswer, GateAnswerSchema } = await import("../src/evidence/gate.js");
    const flat = { decision: "CLAIM", summary: "s", claim: "loop off by one", severity: "High", evidence_needed: "e", verification: "v", evidence_refs: "T1", result: "Confirmed", verdict: "modify" };
    const r = GateAnswerSchema.safeParse(normalizeGateAnswer(flat));
    expect(r.success).toBe(true);
    expect(r.success && r.data.claim).toMatchObject({ claim: "loop off by one", severity: "high", evidence_refs: ["T1"], result: "confirmed", verdict: "MODIFY" });
  });

  it("CostMeter.wrap meters usage and the provider can still read the body", async () => {
    const meter = new CostMeter();
    const inner = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 } }), { status: 200 })) as unknown as typeof fetch;
    const res = await meter.wrap(inner)("http://x", {});
    expect(((await res.json()) as { choices: unknown[] }).choices).toHaveLength(1);
    expect(meter.reported).toBeCloseTo(0.001);
    expect(meter.callsWithoutCost).toBe(0);
  });
});
