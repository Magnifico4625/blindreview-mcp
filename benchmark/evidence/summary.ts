import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { diff, pct } from "../report.js";
import { DEFAULT_REPO_CASES_DIR, loadRepoCases } from "./cases.js";
import { projectVerdict, type CriterionLabel } from "./criteria.js";
import { compareRepoModes, computeRepoMetrics } from "./metrics.js";
import type { RepoBenchmarkReport } from "./runner.js";

/**
 * Cross-model summary of v0.4.0 reports + the pre-registered verdict.
 * Usage: npm run benchmark:evidence-summary -- <labelDir|report.json> [...] [--ledger file]
 */
async function load(p: string): Promise<RepoBenchmarkReport> {
  let file = p;
  if (!p.endsWith(".json")) {
    const files = (await readdir(p)).filter((f) => f.endsWith(".json")).sort();
    if (!files.length) throw new Error(`no report .json in ${p}`);
    file = path.join(p, files[files.length - 1] as string);
  }
  return JSON.parse(await readFile(file, "utf8")) as RepoBenchmarkReport;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const li = args.indexOf("--ledger");
  const ledgerFile = li >= 0 ? args[li + 1] : undefined;
  const inputs = args.filter((_, i) => i !== li && i !== li + 1 || li < 0);
  if (!inputs.length) throw new Error("usage: summary <labelDir|report.json> [...] [--ledger file]");
  const reports = await Promise.all(inputs.map(load));
  const { cases, hash } = await loadRepoCases(DEFAULT_REPO_CASES_DIR);
  const L: string[] = ["# v0.4.0 evidence_gate — cross-model summary", ""];
  L.push("| label | model | runs | case set | git |", "|---|---|---|---|---|");
  for (const r of reports) L.push(`| ${r.label} | ${r.model} | ${r.runs} | ${r.case_set_hash}${r.case_set_hash.startsWith(hash) ? "" : " (DIFFERS from current)"} | ${r.git.sha?.slice(0, 10) ?? "?"}${r.git.dirty ? " dirty" : ""} |`);
  L.push("", "| model | mode | recall testable | recall untestable | FI on correct | WARNING on correct | failed | cost total | cost/review |", "|---|---|---|---|---|---|---|---|---|");
  const labels: CriterionLabel[] = [];
  let total = 0;
  for (const r of reports) {
    for (const mode of r.modes) {
      const m = computeRepoMetrics(mode, cases, r.records, r.config.evidence_limits.maxToolCalls);
      total += m.cost_total_usd;
      if (m.criterion) labels.push(m.criterion);
      L.push(`| ${r.model} | ${mode} | ${pct(m.recall_testable)} | ${pct(m.recall_untestable)} | ${pct(m.false_intervention)} | ${pct(m.warning_on_correct)} | ${m.failed}/${m.expected} | $${m.cost_total_usd.toFixed(4)} | $${(m.cost_per_review_usd ?? 0).toFixed(5)} |`);
    }
  }
  L.push("", "## evidence_gate gate statistics", "", "| model | claims | claimed confirmed | validated | downgraded (correct / flawed) | forced to WARNING (correct / flawed) | ungated FI | ungated recall testable | criterion |", "|---|---|---|---|---|---|---|---|---|");
  for (const r of reports) {
    if (!r.modes.includes("evidence_gate")) continue;
    const m = computeRepoMetrics("evidence_gate", cases, r.records, r.config.evidence_limits.maxToolCalls);
    const g = m.gate;
    if (!g) continue;
    L.push(`| ${r.model} | ${g.claims} | ${g.claimed_confirmed} | ${g.validated} | ${g.downgraded} (${g.downgraded_on_correct} / ${g.downgraded_on_flawed}) | ${g.forced_on_correct} / ${g.forced_on_flawed} | ${pct(g.ungated_false_intervention)} | ${pct(g.ungated_recall_testable)} | **${m.criterion}** |`);
  }
  L.push("", "## Paired comparisons", "");
  for (const r of reports) {
    for (const b of ["decision_judge", "proposal_first"] as const) {
      if (!r.modes.includes("evidence_gate") || !r.modes.includes(b)) continue;
      const c = compareRepoModes("evidence_gate", b, cases, r.records, r.seed);
      L.push(`- ${r.model}: evidence_gate vs ${b}: FI reduction ${diff(c.fi_reduction)}, testable recall loss ${diff(c.recall_testable_loss)}, untestable recall loss ${diff(c.recall_untestable_loss)}`);
    }
  }
  L.push("", `**Pre-registered project verdict: ${projectVerdict(labels)}** (per-model labels: ${labels.join(", ") || "–"})`);
  L.push("", `Cost of the summarized runs: $${total.toFixed(4)}`);
  if (ledgerFile) {
    const lines = (await readFile(ledgerFile, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { cost_usd: number; label: string });
    const byLabel: Record<string, number> = {};
    for (const e of lines) byLabel[e.label] = (byLabel[e.label] ?? 0) + e.cost_usd;
    L.push(`Ledger total (all v0.4.0 runs incl. pilot and failed attempts): $${lines.reduce((s, e) => s + e.cost_usd, 0).toFixed(4)} — ${Object.entries(byLabel).map(([k, x]) => `${k} $${x.toFixed(4)}`).join(", ")}`);
  }
  console.log(`${L.join("\n")}\n`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
