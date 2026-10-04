import type { AnyMode } from "../src/schemas/review.js";
import type { Comparison, ModeMetrics } from "./metrics.js";
import { EXPERIMENT_MODES, type BenchmarkReport } from "./runner.js";
import { THRESHOLDS } from "./thresholds.js";
import type { DiffCI, Rate } from "./stats.js";

export function pct(r: Rate): string {
  if (r.rate === null || !r.ci95) return `– (0/${r.n})`;
  return `${Math.round(r.rate * 100)}% [${Math.round(r.ci95[0] * 100)}–${Math.round(r.ci95[1] * 100)}] (${r.k}/${r.n})`;
}

export function diff(d: DiffCI): string {
  if (d.diff === null || !d.ci95) return "–";
  const s = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}`;
  return `${s(d.diff)} pp [${s(d.ci95[0])}, ${s(d.ci95[1])}]`;
}

const num = (x: number | null, unit = "") => (x === null ? "–" : `${Math.round(x)}${unit}`);

function header(r: BenchmarkReport): string[] {
  const c = r.config;
  return [
    `Label \`${r.label}\` · model \`${r.model}\` via ${r.base_url_host} (${r.provider}) · ${r.created_at}`,
    `git ${r.git.sha?.slice(0, 10) ?? "unknown"}${r.git.dirty ? " (dirty)" : ""} · cases ${r.case_count} (set ${r.case_set_hash}) · ${r.runs} runs/mode/case · seed ${r.seed}`,
    `Budget per review: ${c.max_review_tokens} tokens, ${c.max_tokens_per_call}/call · timeout ${c.timeout_ms} ms · reasoning_effort ${c.reasoning_effort ?? "provider default"} · temperature ${c.temperature ?? "provider default"} · retries ${c.retries} · concurrency ${c.concurrency}`,
    `Prompt hashes: ${Object.entries(r.prompt_hashes).map(([k, v]) => `${k}=${v}`).join(", ")}`,
  ];
}

function mainTable(metrics: ModeMetrics[]): string[] {
  const lines = [
    "| Mode | Decision accuracy | Decision accuracy (strict) | Correct KEEP | Defect detection | Exact verdict | False intervention | Severe false intervention | Avg tokens | Avg latency |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const m of metrics) {
    lines.push(
      `| ${m.mode} | ${pct(m.decision_accuracy)} | ${pct(m.decision_accuracy_strict)} | ${pct(m.keep_accuracy_correct)} | ${pct(m.defect_detection)} | ${pct(m.exact)} | ${pct(m.false_intervention)} | ${pct(m.severe_false_intervention)} | ${num(m.tokens.mean)} | ${num(m.latency_ms.mean === null ? null : m.latency_ms.mean / 1000, " s")} |`,
    );
  }
  return lines;
}

function verdictCell(v: Record<string, number>): string {
  return Object.entries(v)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ") || "–";
}

function comparisonLines(cmp: Comparison[]): string[] {
  const out: string[] = [];
  for (const c of cmp) {
    out.push(`- **${c.question}: ${c.a} vs ${c.b}** — ${c.primary_metric}: ${diff(c.primary)} → **${c.label}**`);
    for (const [k, d] of Object.entries(c.secondary)) out.push(`  - ${k}: ${diff(d)}`);
  }
  return out;
}

export function toMarkdown(r: BenchmarkReport): string {
  const main = r.metrics.filter((m) => !EXPERIMENT_MODES.includes(m.mode));
  const base = r.metrics.find((m) => m.mode === "proposal_first");
  const L: string[] = [`# BlindReview benchmark — ${r.label}`, "", ...header(r), ""];
  L.push(
    "Mechanical metrics, no LLM judge. Rates: value [95% Wilson CI] (k/n) over successful runs; \"strict\" counts failed reviews as wrong. Correct proposals: acceptable verdict is KEEP only. Flawed: MODIFY or REPLACE.",
    "",
    "## Main table",
    "",
    ...mainTable(main),
    "",
    "## Correct proposals",
    "",
    "| Mode | runs (ok) | KEEP accuracy | KEEP (strict) | MODIFY (false intervention) | REPLACE (severe) | IE | verdicts |",
    "|---|---|---|---|---|---|---|---|",
  );
  for (const m of r.metrics) {
    const s = m.by_status.correct;
    if (!s) continue;
    L.push(`| ${m.mode} | ${s.runs} (${s.successful}) | ${pct(m.keep_accuracy_correct)} | ${pct(m.keep_accuracy_correct_strict)} | ${pct(m.false_intervention)} | ${pct(m.severe_false_intervention)} | ${s.verdicts.INSUFFICIENT_EVIDENCE} | ${verdictCell(s.verdicts)} |`);
  }
  L.push("", "## Flawed proposals", "", "| Mode | status | runs (ok) | decision accuracy | verdicts |", "|---|---|---|---|---|");
  for (const m of r.metrics) {
    for (const st of ["materially_flawed", "fundamentally_flawed", "insufficient_information"] as const) {
      const s = m.by_status[st];
      if (s) L.push(`| ${m.mode} | ${st} | ${s.runs} (${s.successful}) | ${pct(s.decision_accuracy)} | ${verdictCell(s.verdicts)} |`);
    }
  }
  L.push("", "| Mode | defect detection | defect detection (strict) | exact verdict | keyword ratio (DIAGNOSTIC ONLY) |", "|---|---|---|---|---|");
  for (const m of r.metrics) L.push(`| ${m.mode} | ${pct(m.defect_detection)} | ${pct(m.defect_detection_strict)} | ${pct(m.exact)} | ${m.keyword_ratio_diagnostic ?? "–"} |`);

  L.push("", "## Cost", "", "| Mode | avg tokens | median tokens | relative to proposal_first | median latency | tokens incl. failed attempts (prompt / completion) |", "|---|---|---|---|---|---|");
  for (const m of r.metrics) {
    const rel = base?.tokens.mean && m.tokens.mean ? `${(m.tokens.mean / base.tokens.mean).toFixed(2)}×` : "–";
    L.push(`| ${m.mode} | ${num(m.tokens.mean)} | ${num(m.tokens.median)} | ${rel} | ${num(m.latency_ms.median === null ? null : m.latency_ms.median / 1000, " s")} | ${m.tokens_all_attempts.prompt_tokens} / ${m.tokens_all_attempts.completion_tokens} |`);
  }

  L.push("", "## Failures", "", "| Mode | expected | successful | failed | reasons | runs that needed retries |", "|---|---|---|---|---|---|");
  for (const m of r.metrics) L.push(`| ${m.mode} | ${m.expected} | ${m.successful} | ${m.failed} | ${verdictCell(m.failure_reasons)} | ${m.retried_runs} |`);

  L.push(
    "",
    "## Questions (pre-registered rules, benchmark/thresholds.ts)",
    "",
    `Labels: clear signal (Δ ≥ ${THRESHOLDS.clear * 100} pp and CI low > 0) · weak signal (Δ ≥ ${THRESHOLDS.weak * 100} pp and CI low > ${THRESHOLDS.weakLowerBound * 100} pp) · no observed advantage (Δ ≤ 0) · inconclusive (otherwise). CIs: paired bootstrap over cases.`,
    "",
    ...comparisonLines(r.comparisons.filter((c) => c.question !== "Q4")),
    "",
    "## Experiment: decision_judge vs proposal_first (not part of the main table)",
    "",
    ...experimentSection(r),
  );
  return `${L.join("\n")}\n`;
}

export function experimentSection(r: BenchmarkReport): string[] {
  const modes: AnyMode[] = ["proposal_first", "decision_judge"];
  const ms = r.metrics.filter((m) => modes.includes(m.mode));
  if (ms.length < 2) return ["(not run)"];
  return [...mainTable(ms), "", ...comparisonLines(r.comparisons.filter((c) => c.question === "Q4"))];
}

export function toExperimentMarkdown(r: BenchmarkReport): string {
  return `${[`# Experiment: decision_judge vs proposal_first — ${r.label}`, "", ...header(r), "", ...experimentSection(r)].join("\n")}\n`;
}
