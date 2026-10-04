import { diff, pct } from "../report.js";
import type { RepoCase } from "./cases.js";
import { CRITERIA } from "./criteria.js";
import { compareRepoModes, computeRepoMetrics, type RepoModeMetrics } from "./metrics.js";
import type { RepoBenchmarkReport } from "./runner.js";

const usd = (x: number | null) => (x === null ? "–" : `$${x.toFixed(x < 0.01 ? 5 : 4)}`);
const cell = (v: Record<string, number>) => Object.entries(v).sort().map(([k, n]) => `${k} ${n}`).join(", ") || "–";

export function repoMetrics(r: RepoBenchmarkReport, cases: RepoCase[]): RepoModeMetrics[] {
  return r.modes.map((m) => computeRepoMetrics(m, cases, r.records, r.config.evidence_limits.maxToolCalls));
}

export function repoMarkdown(r: RepoBenchmarkReport, cases: RepoCase[]): string {
  const ms = repoMetrics(r, cases);
  const L: string[] = [
    `# v0.4.0 repo-snapshot benchmark — ${r.label}`,
    "",
    `Model \`${r.model}\` via ${r.base_url_host} · ${r.created_at} · git ${r.git.sha?.slice(0, 10) ?? "?"}${r.git.dirty ? " (dirty)" : ""}`,
    `Cases ${r.case_count} (set ${r.case_set_hash}) · ${r.runs} run(s)/mode/case · seed ${r.seed} · modes ${r.modes.join(", ")}`,
    `evidence_gate limits: ${r.config.evidence_limits.maxToolCalls} tool calls, ${r.config.evidence_limits.maxReviewTokens} tokens/review, ${r.config.evidence_limits.maxTokensPerCall}/call, timeout ${r.config.evidence_limits.timeoutMs} ms · text baselines: ${r.config.text_max_review_tokens} tokens/review · reasoning ${r.config.reasoning_effort ?? "provider default"} · temperature ${r.config.temperature ?? "provider default"}`,
    `Prices (per 1M tokens): prompt $${(r.pricing.prompt * 1e6).toFixed(3)}, completion $${(r.pricing.completion * 1e6).toFixed(3)} · prompt hashes: ${Object.entries(r.prompt_hashes).filter(([k]) => ["evidence_gate", "decision_judge", "proposal_first", "repair"].includes(k)).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    "",
    "Mechanical metrics, no LLM judge. Rates: value [95% Wilson CI] (k/n) over successful runs. Intervention = MODIFY/REPLACE; WARNING is not an intervention. Runs of the same case are correlated, so Wilson intervals over runs are optimistic.",
    "",
    "## Main table",
    "",
    "| Mode | Recall testable defects | Recall untestable defects | False intervention (correct) | WARNING on correct | KEEP on correct | failed | avg tokens | cost total | cost/review |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const m of ms) {
    L.push(`| ${m.mode} | ${pct(m.recall_testable)} | ${pct(m.recall_untestable)} | ${pct(m.false_intervention)} | ${pct(m.warning_on_correct)} | ${pct(m.keep_on_correct)} | ${m.failed}/${m.expected}${m.failed ? ` (${cell(m.failure_reasons)})` : ""} | ${m.tokens_mean ?? "–"} | ${usd(m.cost_total_usd)} | ${usd(m.cost_per_review_usd)} |`);
  }
  L.push("", "## Recall by defect kind and verdict distributions", "", "| Mode | test | typecheck | search | untestable | flagged incl. WARNING (testable / untestable) | verdicts on correct | verdicts on flawed |", "|---|---|---|---|---|---|---|---|");
  for (const m of ms) {
    const k = m.recall_by_kind;
    L.push(`| ${m.mode} | ${k.test ? pct(k.test) : "–"} | ${k.typecheck ? pct(k.typecheck) : "–"} | ${k.search ? pct(k.search) : "–"} | ${k.untestable ? pct(k.untestable) : "–"} | ${pct(m.flagged_testable)} / ${pct(m.flagged_untestable)} | ${cell(m.verdicts_correct)} | ${cell(m.verdicts_flawed)} |`);
  }
  const eg = ms.find((m) => m.mode === "evidence_gate");
  if (eg?.gate) {
    const g = eg.gate;
    L.push(
      "",
      "## evidence_gate: what the harness gate did",
      "",
      `- Claims made: ${g.claims}/${eg.successful}; model said "confirmed": ${g.claimed_confirmed}; validated by the harness: ${g.validated} (${cell(g.validated_by_artifact)}); **downgraded confirmed → not_confirmed: ${g.downgraded}** (on correct ${g.downgraded_on_correct}, on flawed ${g.downgraded_on_flawed}).`,
      `- MODIFY/REPLACE forced to WARNING: on correct ${g.forced_on_correct}, on flawed ${g.forced_on_flawed}.`,
      `- Ungated counterfactual (model's own verdict): FI ${pct(g.ungated_false_intervention)}, recall testable ${pct(g.ungated_recall_testable)}, recall untestable ${pct(g.ungated_recall_untestable)}.`,
      `- Tool calls per review: mean ${g.tool_calls_mean ?? "–"}; reviews that hit the cap: ${g.hit_tool_cap}; usage: ${cell(g.tool_usage)}.`,
      "",
      `Pre-registered criterion for this model (docs/v0.4-evidence-gate.md): continue if recall(testable) ≥ ${CRITERIA.continueMinRecall * 100}% and FI ≤ ${CRITERIA.continueMaxFI * 100}%; archive if FI ≥ ${CRITERIA.archiveMinFI * 100}% → **${eg.criterion}**`,
    );
  }
  const comps = [];
  if (r.modes.includes("evidence_gate") && r.modes.includes("decision_judge")) comps.push(compareRepoModes("evidence_gate", "decision_judge", cases, r.records, r.seed));
  if (r.modes.includes("evidence_gate") && r.modes.includes("proposal_first")) comps.push(compareRepoModes("evidence_gate", "proposal_first", cases, r.records, r.seed));
  if (comps.length) {
    L.push("", "## Paired comparisons (case bootstrap, descriptive only)", "");
    for (const c of comps) {
      L.push(`- **${c.a} vs ${c.b}**: FI reduction (FI ${c.b} − FI ${c.a}) ${diff(c.fi_reduction)}; testable recall loss (${c.b} − ${c.a}) ${diff(c.recall_testable_loss)}; untestable recall loss ${diff(c.recall_untestable_loss)}`);
    }
  }
  L.push("", "## Per case", "", "| case | kind | " + r.modes.join(" | ") + " |", "|---|---|" + r.modes.map(() => "---|").join(""));
  for (const c of cases) {
    const cells = r.modes.map((m) =>
      r.records
        .filter((x) => x.case_id === c.id && x.mode === m)
        .map((x) => (x.ok ? (m === "evidence_gate" && x.model_verdict !== x.verdict ? `${x.verdict}←${x.model_verdict}` : (x.verdict ?? "?")) + (m === "evidence_gate" && x.evidence?.gate.status === "downgraded" ? "(dg)" : "") : "FAIL"))
        .join(" "),
    );
    L.push(`| ${c.id} | ${c.ground_truth.defect_kind} | ${cells.join(" | ")} |`);
  }
  L.push("", "`X←Y`: the gate turned the model's verdict Y into X. `(dg)`: model claimed confirmed, harness downgraded.");
  return `${L.join("\n")}\n`;
}
