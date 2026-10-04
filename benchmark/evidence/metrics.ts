import { mean, median, pairedBootstrapDiff, round, wilson, type DiffCI, type Rate } from "../stats.js";
import { isRepoCorrect, isRepoFlawed, isTestableDefect, isUntestableDefect, type DefectKind, type RepoCase } from "./cases.js";
import { criterionLabel, type CriterionLabel } from "./criteria.js";
import type { RepoMode, RepoRunRecord } from "./runner.js";

/**
 * Mechanical metrics for the v0.4.0 repo-snapshot benchmark (no LLM judge).
 *   intervention     = verdict MODIFY or REPLACE (WARNING / KEEP / INSUFFICIENT_EVIDENCE are not)
 *   recall           = intervention rate on defect cases (testable / untestable / all)
 *   flagged          = MODIFY, REPLACE or WARNING on defect cases (secondary)
 *   false intervention (FI) = intervention rate on correct proposals
 *   warning rate on correct = WARNING on correct proposals (noise that does not block the change)
 * Rates are over successful runs; failures are counted and shown separately.
 * evidence_gate also gets: claimed-confirmed / validated / downgraded counts, verdicts forced by the
 * gate, and an UNGATED counterfactual using the model's own verdict (what the same answers would
 * score without the harness gate).
 */
export interface RepoModeMetrics {
  mode: RepoMode;
  expected: number;
  successful: number;
  failed: number;
  failure_reasons: Record<string, number>;
  recall_testable: Rate;
  recall_untestable: Rate;
  recall_all: Rate;
  recall_by_kind: Partial<Record<DefectKind, Rate>>;
  flagged_testable: Rate;
  flagged_untestable: Rate;
  false_intervention: Rate;
  warning_on_correct: Rate;
  keep_on_correct: Rate;
  verdicts_correct: Record<string, number>;
  verdicts_flawed: Record<string, number>;
  gate?: {
    claims: number;
    claimed_confirmed: number;
    validated: number;
    downgraded: number;
    downgraded_on_correct: number;
    downgraded_on_flawed: number;
    forced_on_correct: number;
    forced_on_flawed: number;
    validated_by_artifact: Record<string, number>;
    ungated_false_intervention: Rate;
    ungated_recall_testable: Rate;
    ungated_recall_untestable: Rate;
    tool_calls_mean: number | null;
    tool_usage: Record<string, number>;
    hit_tool_cap: number;
  };
  tokens_mean: number | null;
  tokens_median: number | null;
  latency_median_ms: number | null;
  cost_total_usd: number;
  cost_per_review_usd: number | null;
  criterion?: CriterionLabel;
}

const intervene = (v: string | undefined) => v === "MODIFY" || v === "REPLACE";

export function computeRepoMetrics(mode: RepoMode, cases: RepoCase[], records: RepoRunRecord[], maxToolCalls = 8): RepoModeMetrics {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const rows = records.filter((r) => r.mode === mode && byId.has(r.case_id)).map((r) => ({ r, c: byId.get(r.case_id) as RepoCase }));
  const ok = rows.filter((x) => x.r.ok);
  type Row = (typeof rows)[number];
  const rate = (sel: Row[], pred: (x: Row) => boolean) => wilson(sel.filter(pred).length, sel.length);
  const testable = ok.filter((x) => isTestableDefect(x.c));
  const untestable = ok.filter((x) => isUntestableDefect(x.c));
  const flawed = ok.filter((x) => isRepoFlawed(x.c));
  const correct = ok.filter((x) => isRepoCorrect(x.c));
  const count = (sel: Row[], f: (x: Row) => string | undefined) => {
    const out: Record<string, number> = {};
    for (const x of sel) {
      const k = f(x) ?? "?";
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };
  const failure_reasons: Record<string, number> = {};
  for (const x of rows) if (!x.r.ok) failure_reasons[x.r.error?.code ?? "UNKNOWN"] = (failure_reasons[x.r.error?.code ?? "UNKNOWN"] ?? 0) + 1;
  const recall_by_kind: RepoModeMetrics["recall_by_kind"] = {};
  for (const k of ["test", "typecheck", "search", "untestable"] as const) {
    const sel = flawed.filter((x) => x.c.ground_truth.defect_kind === k);
    if (sel.length) recall_by_kind[k] = rate(sel, (x) => intervene(x.r.verdict));
  }
  const tokens = ok.map((x) => x.r.usage_all_attempts.total_tokens);
  const lat = ok.map((x) => x.r.latency_ms);
  const cost_total_usd = rows.reduce((s, x) => s + x.r.cost_usd_all_attempts, 0);
  const m: RepoModeMetrics = {
    mode,
    expected: rows.length,
    successful: ok.length,
    failed: rows.length - ok.length,
    failure_reasons,
    recall_testable: rate(testable, (x) => intervene(x.r.verdict)),
    recall_untestable: rate(untestable, (x) => intervene(x.r.verdict)),
    recall_all: rate(flawed, (x) => intervene(x.r.verdict)),
    recall_by_kind,
    flagged_testable: rate(testable, (x) => intervene(x.r.verdict) || x.r.verdict === "WARNING"),
    flagged_untestable: rate(untestable, (x) => intervene(x.r.verdict) || x.r.verdict === "WARNING"),
    false_intervention: rate(correct, (x) => intervene(x.r.verdict)),
    warning_on_correct: rate(correct, (x) => x.r.verdict === "WARNING"),
    keep_on_correct: rate(correct, (x) => x.r.verdict === "KEEP"),
    verdicts_correct: count(correct, (x) => x.r.verdict),
    verdicts_flawed: count(flawed, (x) => x.r.verdict),
    tokens_mean: tokens.length ? round(mean(tokens) as number, 1) : null,
    tokens_median: median(tokens),
    latency_median_ms: median(lat),
    cost_total_usd: round(cost_total_usd, 6),
    cost_per_review_usd: rows.length ? round(cost_total_usd / rows.length, 6) : null,
  };
  if (mode === "evidence_gate") {
    const ev = ok.filter((x) => x.r.evidence);
    const g = (x: Row) => x.r.evidence?.gate;
    const validated_by_artifact: Record<string, number> = {};
    for (const x of ev) if (g(x)?.status === "validated") for (const t of new Set(g(x)?.matched.map((mm) => mm.artifact.type))) validated_by_artifact[t] = (validated_by_artifact[t] ?? 0) + 1;
    const tool_usage: Record<string, number> = {};
    for (const x of ev) for (const t of x.r.evidence?.tool_log ?? []) tool_usage[t.tool] = (tool_usage[t.tool] ?? 0) + 1;
    const toolCounts = ev.map((x) => x.r.evidence?.tool_log.length ?? 0);
    m.gate = {
      claims: ev.filter((x) => g(x)?.status !== "no_claim").length,
      claimed_confirmed: ev.filter((x) => g(x)?.model_result === "confirmed").length,
      validated: ev.filter((x) => g(x)?.status === "validated").length,
      downgraded: ev.filter((x) => g(x)?.status === "downgraded").length,
      downgraded_on_correct: ev.filter((x) => g(x)?.status === "downgraded" && isRepoCorrect(x.c)).length,
      downgraded_on_flawed: ev.filter((x) => g(x)?.status === "downgraded" && isRepoFlawed(x.c)).length,
      forced_on_correct: ev.filter((x) => g(x)?.verdict_forced && isRepoCorrect(x.c)).length,
      forced_on_flawed: ev.filter((x) => g(x)?.verdict_forced && isRepoFlawed(x.c)).length,
      validated_by_artifact,
      ungated_false_intervention: rate(correct, (x) => intervene(x.r.model_verdict)),
      ungated_recall_testable: rate(testable, (x) => intervene(x.r.model_verdict)),
      ungated_recall_untestable: rate(untestable, (x) => intervene(x.r.model_verdict)),
      tool_calls_mean: toolCounts.length ? round(mean(toolCounts) as number, 2) : null,
      tool_usage,
      hit_tool_cap: toolCounts.filter((n) => n >= maxToolCalls).length,
    };
    m.criterion = criterionLabel(m.recall_testable, m.false_intervention, rows.length ? m.failed / rows.length : 0);
  }
  return m;
}

/** Paired case bootstrap: Δ = rate(b) − rate(a) on the selected cases (successful runs). */
export function pairedDiff(a: RepoMode, b: RepoMode, cases: RepoCase[], records: RepoRunRecord[], include: (c: RepoCase) => boolean, seed: number): DiffCI {
  const lists = (mode: RepoMode) =>
    cases.filter(include).map((c) =>
      records
        .filter((r) => r.mode === mode && r.case_id === c.id && r.ok)
        .map((r) => (intervene(r.verdict) ? 1 : 0) as 0 | 1),
    );
  return pairedBootstrapDiff(lists(b), lists(a), { seed });
}

export interface RepoComparison {
  a: RepoMode;
  b: RepoMode;
  fi_reduction: DiffCI; // FI(b) − FI(a): positive = a intervenes less on correct proposals
  recall_testable_loss: DiffCI; // recall(b) − recall(a) on testable defects: positive = a misses more
  recall_untestable_loss: DiffCI;
}

export function compareRepoModes(a: RepoMode, b: RepoMode, cases: RepoCase[], records: RepoRunRecord[], seed: number): RepoComparison {
  return {
    a,
    b,
    fi_reduction: pairedDiff(a, b, cases, records, isRepoCorrect, seed),
    recall_testable_loss: pairedDiff(a, b, cases, records, isTestableDefect, seed),
    recall_untestable_loss: pairedDiff(a, b, cases, records, isUntestableDefect, seed),
  };
}
