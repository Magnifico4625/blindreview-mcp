import { readFile, writeFile } from "node:fs/promises";
import { fmtRate, wilson } from "../stats.js";
import { FOLLOWUP_CRITERIA, followupVerdict } from "./criteria.js";

/**
 * Summary for the v0.4.0 follow-up on tempting-correct cases (docs/v0.4-evidence-gate.md section 8).
 * Usage: node dist/benchmark/evidence/followup.js <report.json> [out.md]
 * All cases in this set are correct, so every MODIFY/REPLACE is a false intervention.
 */
interface Rec {
  case_id: string;
  run: number;
  mode: string;
  ok: boolean;
  verdict?: string;
  model_verdict?: string;
  error?: { code?: string };
  cost_usd_all_attempts?: number;
  evidence?: { gate: { status: string; model_verdict: string; final_verdict: string; verdict_forced: boolean; model_result: string | null; matched: Array<{ artifact: { type: string } }> }; answer?: { claim?: { claim?: string } | null } };
}

const isFI = (v: string | undefined) => v === "MODIFY" || v === "REPLACE";

async function main(): Promise<void> {
  const [file, out] = process.argv.slice(2);
  if (!file) throw new Error("usage: followup.js <report.json> [out.md]");
  const rep = JSON.parse(await readFile(file, "utf8")) as { label: string; model: string; runs: number; case_set_hash: string; git: { sha: string; dirty: boolean }; records: Rec[] };
  const L: string[] = [`# v0.4.0 follow-up: tempting-correct cases — ${rep.label}`, "", `Model \`${rep.model}\` · case set ${rep.case_set_hash} · ${rep.runs} run(s) · git ${rep.git.sha.slice(0, 10)}${rep.git.dirty ? " dirty" : ""}. All cases are correct; FI = MODIFY/REPLACE rate over successful runs; Wilson 95% CIs (optimistic: runs of a case are correlated).`, ""];
  const stats: Record<string, { fi: ReturnType<typeof wilson>; failShare: number }> = {};
  L.push("| mode | FI | WARNING | KEEP | INSUFFICIENT_EVIDENCE | failed | cost |", "|---|---|---|---|---|---|---|");
  for (const mode of ["evidence_gate", "decision_judge"]) {
    const rs = rep.records.filter((r) => r.mode === mode);
    const ok = rs.filter((r) => r.ok);
    const cnt = (v: string) => ok.filter((r) => r.verdict === v).length;
    const fi = wilson(ok.filter((r) => isFI(r.verdict)).length, ok.length);
    stats[mode] = { fi, failShare: rs.length ? (rs.length - ok.length) / rs.length : 0 };
    const cost = rs.reduce((a, r) => a + (r.cost_usd_all_attempts ?? 0), 0);
    const fails = rs.filter((r) => !r.ok).map((r) => r.error?.code ?? "?");
    L.push(`| ${mode} | ${fmtRate(fi)} | ${fmtRate(wilson(cnt("WARNING"), ok.length))} | ${fmtRate(wilson(cnt("KEEP"), ok.length))} | ${cnt("INSUFFICIENT_EVIDENCE")} | ${rs.length - ok.length}/${rs.length}${fails.length ? ` (${fails.join(", ")})` : ""} | $${cost.toFixed(4)} |`);
  }
  const eg = rep.records.filter((r) => r.mode === "evidence_gate" && r.ok && r.evidence);
  const g = eg.map((r) => r.evidence!.gate);
  const ungated = wilson(g.filter((x) => isFI(x.model_verdict)).length, g.length);
  const by = (s: string) => g.filter((x) => x.status === s).length;
  L.push("", "## evidence_gate: gate", "", `- Claims: ${g.filter((x) => x.status !== "no_claim").length}/${g.length}; model said "confirmed": ${g.filter((x) => x.model_result === "confirmed").length}; validated: ${by("validated")}; **downgraded: ${by("downgraded")}**; MODIFY/REPLACE forced to WARNING: ${g.filter((x) => x.verdict_forced).length}.`);
  L.push(`- Ungated counterfactual (model's own verdict): FI ${fmtRate(ungated)}.`);
  const val = eg.filter((r) => r.evidence!.gate.status === "validated" && isFI(r.verdict));
  L.push(`- Interventions that passed the gate (all false, since every case is correct): ${val.length}${val.length ? " — " + val.map((r) => `${r.case_id} run${r.run} via ${[...new Set(r.evidence!.gate.matched.map((m) => m.artifact.type))].join("+")}`).join("; ") : ""}. POST-HOC, not pre-registered: on a correct case no artifact can demonstrate a real defect, so each of these is an irrelevant-artifact validation (known search_hit limitation).`);
  L.push("", "## Per case", "", "| case | evidence_gate | decision_judge |", "|---|---|---|");
  const cases = [...new Set(rep.records.map((r) => r.case_id))].sort();
  const cell = (c: string, m: string) => rep.records.filter((r) => r.case_id === c && r.mode === m).sort((a, b) => a.run - b.run).map((r) => (!r.ok ? "FAIL" : m === "evidence_gate" && r.evidence && r.evidence.gate.model_verdict !== r.verdict ? `${r.verdict}←${r.evidence.gate.model_verdict}` : (r.verdict ?? "?"))).join(" ");
  for (const c of cases) L.push(`| ${c} | ${cell(c, "evidence_gate")} | ${cell(c, "decision_judge")} |`);
  const eS = stats.evidence_gate!, dS = stats.decision_judge!;
  const verdict = followupVerdict(eS.fi, dS.fi, eS.failShare, dS.failShare);
  L.push("", "## Pre-registered follow-up criterion (section 8)", "", `- Temptation check: decision_judge FI ${fmtRate(dS.fi)} — ${dS.fi.rate !== null && dS.fi.rate >= FOLLOWUP_CRITERIA.temptationMinFI ? "passed (≥ 30%)" : "**failed (< 30%): the set is not tempting, result inconclusive by construction**"}.`, `- evidence_gate FI ${fmtRate(eS.fi)} (alive < 20%, archive ≥ 40%).`, `- Failed reviews: evidence_gate ${(eS.failShare * 100).toFixed(0)}%, decision_judge ${(dS.failShare * 100).toFixed(0)}% (limit 10%).`, "", `**Verdict: ${verdict}**`, "");
  const md = L.join("\n");
  if (out) await writeFile(out, md);
  console.log(md);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
