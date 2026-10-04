import { z } from "zod";
import type { Artifact } from "./sandbox.js";

/**
 * evidence_gate (v0.4.0): the model may only intervene (MODIFY / REPLACE) with a claim that a
 * TOOL in the same session confirmed mechanically. The harness, not the model, decides whether a
 * claim counts as confirmed.
 */
export const GATE_VERDICTS = ["KEEP", "WARNING", "MODIFY", "REPLACE"] as const;
export type GateVerdict = (typeof GATE_VERDICTS)[number];
export const CLAIM_RESULTS = ["confirmed", "not_confirmed", "unable_to_verify"] as const;
export type ClaimResult = (typeof CLAIM_RESULTS)[number];

export const ClaimSchema = z.object({
  claim: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
  evidence_needed: z.string().min(1),
  verification: z.string().min(1),
  /** Tool-call ids ("T3") and/or locations ("src/a.js:12") that support the claim. */
  evidence_refs: z.array(z.string()).max(20).default([]),
  result: z.enum(CLAIM_RESULTS),
  verdict: z.enum(GATE_VERDICTS),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const GateAnswerSchema = z.object({
  decision: z.enum(["KEEP", "CLAIM"]),
  summary: z.string().min(1),
  claim: ClaimSchema.nullable().default(null),
});
export type GateAnswer = z.infer<typeof GateAnswerSchema>;

export function normalizeGateAnswer(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const v = { ...(value as Record<string, unknown>) };
  if (typeof v.decision === "string") v.decision = v.decision.trim().toUpperCase();
  if (v.claim && typeof v.claim === "object") {
    const c = { ...(v.claim as Record<string, unknown>) };
    if (typeof c.verdict === "string") c.verdict = c.verdict.trim().toUpperCase();
    if (typeof c.result === "string") c.result = c.result.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (typeof c.severity === "string") c.severity = c.severity.trim().toLowerCase();
    if (typeof c.evidence_refs === "string") c.evidence_refs = [c.evidence_refs];
    if (c.evidence_refs === null || c.evidence_refs === undefined) c.evidence_refs = [];
    v.claim = c;
  }
  if (v.decision === "KEEP" && v.claim === undefined) v.claim = null;
  return v;
}

/** One executed tool call as recorded by the harness. */
export interface ToolLogEntry {
  id: string; // "T1", "T2", ...
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  artifacts: Artifact[];
  output_chars: number;
  ms: number;
}

/** Lines (new-file numbering) added or modified by the proposed change, per repo-relative file. */
export type ChangedLines = Map<string, Set<number>>;

/** Parse a unified diff (a/ b/ prefixes) into the set of '+' lines per new file. */
export function changedLinesFromDiff(diff: string): ChangedLines {
  const out: ChangedLines = new Map();
  let file: string | null = null;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      file = p === "/dev/null" ? null : p.replace(/^b\//, "");
      if (file && !out.has(file)) out.set(file, new Set());
      continue;
    }
    if (line.startsWith("--- ")) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      newLine = Number(h[1]);
      continue;
    }
    if (!file) continue;
    if (line.startsWith("+")) {
      out.get(file)?.add(newLine);
      newLine++;
    } else if (line.startsWith("-")) {
      // removed line: no new-file number
    } else if (line.startsWith(" ") || line === "") {
      newLine++;
    }
  }
  return out;
}

/**
 * Which artifacts can confirm a claim:
 *  - failing_test and typecheck_error always (they are produced by running code / the compiler);
 *  - search_hit only OUTSIDE the lines added by the proposed change. A hit on the proposal's own
 *    lines only quotes the proposal back; it cannot show that something elsewhere contradicts it.
 */
export function qualifies(a: Artifact, changed: ChangedLines): boolean {
  if (a.type !== "search_hit") return true;
  return !(a.line !== undefined && changed.get(a.file)?.has(a.line));
}

export type ValidationStatus =
  | "no_claim" // decision KEEP, nothing to validate
  | "validated" // model said confirmed and a cited, qualifying artifact exists
  | "downgraded" // model said confirmed but the harness found no matching artifact
  | "not_claimed_confirmed"; // model itself reported not_confirmed / unable_to_verify

export interface GateOutcome {
  /** What the model asked for (claim.verdict, or KEEP). */
  model_verdict: GateVerdict;
  /** After the harness gate. */
  final_verdict: GateVerdict;
  model_result: ClaimResult | null;
  final_result: ClaimResult | null;
  status: ValidationStatus;
  reason: string;
  matched: Array<{ tool_call: string; artifact: Artifact }>;
  /** true when the gate changed the verdict (MODIFY/REPLACE -> WARNING). */
  verdict_forced: boolean;
}

const LOC = /([A-Za-z0-9_.\-/]+\.[A-Za-z0-9]+):(\d+)/g;
const ID = /\bT(\d+)\b/g;

/** Harness-side validation of a model answer against the session's tool log. */
export function applyGate(answer: GateAnswer, log: readonly ToolLogEntry[], changed: ChangedLines): GateOutcome {
  const claim = answer.decision === "CLAIM" ? answer.claim : null;
  if (!claim) {
    return { model_verdict: "KEEP", final_verdict: "KEEP", model_result: null, final_result: null, status: "no_claim", reason: answer.decision === "CLAIM" ? "CLAIM without claim object treated as KEEP" : "no material defect claimed", matched: [], verdict_forced: false };
  }
  const intervention = claim.verdict === "MODIFY" || claim.verdict === "REPLACE";
  let status: ValidationStatus;
  let reason: string;
  let matched: GateOutcome["matched"] = [];
  if (claim.result !== "confirmed") {
    status = "not_claimed_confirmed";
    reason = `model reported ${claim.result}`;
  } else {
    matched = matchEvidence(claim, log, changed);
    if (matched.length) {
      status = "validated";
      reason = `matched ${matched.length} artifact(s): ${[...new Set(matched.map((m) => `${m.tool_call}:${m.artifact.type}`))].join(", ")}`;
    } else {
      status = "downgraded";
      reason = claim.evidence_refs.length
        ? `cited ${claim.evidence_refs.join(", ")} but no cited tool output contains a qualifying artifact (failing test, typecheck error, or search hit outside the changed lines)`
        : "claimed confirmed without citing any tool output";
    }
  }
  const finalResult: ClaimResult = status === "downgraded" ? "not_confirmed" : claim.result;
  const forced = intervention && status !== "validated";
  return {
    model_verdict: claim.verdict,
    final_verdict: forced ? "WARNING" : claim.verdict,
    model_result: claim.result,
    final_result: finalResult,
    status,
    reason,
    matched,
    verdict_forced: forced,
  };
}

function matchEvidence(claim: Claim, log: readonly ToolLogEntry[], changed: ChangedLines): GateOutcome["matched"] {
  const refsText = claim.evidence_refs.join(" ");
  const byId = new Map(log.map((e) => [e.id, e]));
  const out: GateOutcome["matched"] = [];
  const seen = new Set<string>();
  const push = (tool_call: string, a: Artifact) => {
    const k = `${tool_call}|${a.type}|${a.file}|${a.line ?? ""}|${a.detail}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ tool_call, artifact: a });
    }
  };
  const locs = [...refsText.matchAll(LOC)].map((m) => ({ file: (m[1] as string).replace(/^\.\//, "").replace(/^b\//, ""), line: Number(m[2]) }));
  // 1) tool-call ids: the cited call must contain at least one qualifying artifact. If locations are
  //    also cited, a search hit from that call must match one of them.
  for (const m of refsText.matchAll(ID)) {
    const e = byId.get(`T${m[1]}`);
    if (!e) continue;
    for (const a of e.artifacts) {
      if (!qualifies(a, changed)) continue;
      if (a.type === "search_hit" && locs.length && !locs.some((l) => sameFile(l.file, a.file) && l.line === a.line)) continue;
      push(e.id, a);
    }
  }
  // 2) bare locations: must equal a qualifying search hit or typecheck error location from this session.
  for (const l of locs) {
    for (const e of log) {
      for (const a of e.artifacts) {
        if (a.type === "failing_test" || a.line !== l.line || !sameFile(l.file, a.file) || !qualifies(a, changed)) continue;
        push(e.id, a);
      }
    }
  }
  return out;
}

function sameFile(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}
