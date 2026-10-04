import type { Config } from "../../src/config.js";
import { DEFAULT_EVIDENCE_LIMITS, EvidenceGateError, runEvidenceGate, type EvidenceGateLimits, type EvidenceGateResult } from "../../src/evidence/judge.js";
import { RepoSandbox } from "../../src/evidence/sandbox.js";
import type { ToolChatProvider } from "../../src/evidence/tool-provider.js";
import type { ReviewerProvider } from "../../src/providers/provider.js";
import { Reviewer } from "../../src/reviewer/reviewer.js";
import { ReviewError, type ReviewResult, type Usage } from "../../src/schemas/review.js";
import { gitInfo } from "../meta.js";
import { promptHashes } from "../../src/reviewer/prompt-fingerprint.js";
import { rng, shuffle } from "../stats.js";
import { changedLinesOf, toBaselineInput, toRepoView, type RepoCase } from "./cases.js";
import { CostMeter, estimateCost, type Pricing, type SpendLedger } from "./cost.js";

export const REPO_MODES = ["evidence_gate", "decision_judge", "proposal_first"] as const;
export type RepoMode = (typeof REPO_MODES)[number];

export interface RepoRunRecord {
  case_id: string;
  run: number;
  mode: RepoMode;
  model: string;
  attempts: number;
  retries: Array<{ code: string; message: string; status?: number }>;
  ok: boolean;
  /** Final verdict (after the gate for evidence_gate). */
  verdict?: string;
  /** evidence_gate only: verdict the model asked for before the gate. */
  model_verdict?: string;
  evidence?: Omit<EvidenceGateResult, "meta"> & { meta: EvidenceGateResult["meta"] };
  review?: ReviewResult;
  error?: { code: string; message: string; status?: number };
  usage_all_attempts: Usage;
  cost_usd_all_attempts: number;
  cost_source: "reported" | "estimated" | "mixed";
  latency_ms: number;
}

/** Fresh providers per review (cost is metered per review). */
export interface ProviderFactory {
  tool(): ToolChatProvider;
  text(meter: CostMeter): ReviewerProvider;
}

export interface RepoBenchmarkOptions {
  label: string;
  model: string;
  modes: readonly RepoMode[];
  runs: number;
  seed: number;
  concurrency: number;
  retries: number;
  retryDelayMs?: number;
  caseSetHash: string;
  providers: ProviderFactory;
  pricing: Pricing;
  ledger: SpendLedger;
  /** Stop starting new reviews once ledger spend + in-flight reserve would exceed this. */
  hardStopUsd: number;
  /** Worst-case cost reserved per in-flight review for the hard-stop check. */
  reservePerReviewUsd: Record<RepoMode, number>;
  evidenceLimits?: Partial<EvidenceGateLimits>;
  resumeRecords?: RepoRunRecord[];
  onRecord?: (r: RepoRunRecord) => void | Promise<void>;
  log?: (m: string) => void;
}

export class BudgetStop extends Error {
  constructor(
    readonly spent: number,
    readonly completed: number,
    readonly expected: number,
  ) {
    super(`hard budget stop: ledger spend $${spent.toFixed(4)}; ${completed}/${expected} records done; rerun with --resume (and a higher cap only if the user approves)`);
  }
}

export interface RepoBenchmarkReport {
  schema: "blindreview-repo-benchmark/v1";
  label: string;
  created_at: string;
  git: { sha: string | null; dirty: boolean | null };
  model: string;
  base_url_host: string;
  config: { evidence_limits: EvidenceGateLimits; text_max_review_tokens: number; text_max_tokens_per_call: number; reasoning_effort: string | null; temperature: number | null; retries: number; concurrency: number };
  pricing: Pricing;
  case_set_hash: string;
  case_count: number;
  prompt_hashes: Record<string, string>;
  modes: RepoMode[];
  runs: number;
  seed: number;
  records: RepoRunRecord[];
}

const TRANSIENT = new Set(["TIMEOUT", "PROVIDER_NETWORK_ERROR"]);
const isTransient = (e: { code: string; status?: number | undefined }) => TRANSIENT.has(e.code) || (e.code === "PROVIDER_HTTP_ERROR" && e.status !== undefined && (e.status === 429 || e.status >= 500));
export const reusableRepoRecord = (r: RepoRunRecord) => r.ok || !(r.error && isTransient(r.error));

export async function runRepoBenchmark(cases: RepoCase[], config: Config, o: RepoBenchmarkOptions): Promise<RepoBenchmarkReport> {
  const log = o.log ?? (() => {});
  const git = gitInfo();
  const random = rng(o.seed);
  const limits = { ...DEFAULT_EVIDENCE_LIMITS, ...o.evidenceLimits };
  const modes = [...o.modes];
  const units: Array<{ c: RepoCase; run: number; order: RepoMode[] }> = [];
  for (let run = 1; run <= o.runs; run++) for (const c of cases) units.push({ c, run, order: shuffle(modes, random) });
  const key = (id: string, run: number, mode: string) => `${id}\u0000${run}\u0000${mode}`;
  const records: RepoRunRecord[] = [];
  const done = new Set<string>();
  for (const r of o.resumeRecords ?? []) {
    const k = key(r.case_id, r.run, r.mode);
    if (!done.has(k) && reusableRepoRecord(r) && units.some((u) => u.c.id === r.case_id && u.run === r.run) && modes.includes(r.mode)) {
      done.add(k);
      records.push(r);
    }
  }
  if (done.size) log(`resuming: ${done.size} records reused`);
  const expected = units.length * modes.length;

  const once = async (c: RepoCase, mode: RepoMode): Promise<{ ok: true; rec: Partial<RepoRunRecord>; usage: Usage; cost: number; source: "reported" | "estimated" } | { ok: false; err: ReviewError; usage: Usage; cost: number; source: "reported" | "estimated" }> => {
    const sandbox = await RepoSandbox.open(c.repoDir);
    const files = sandbox.listFiles();
    const tests = sandbox.testAllowlist();
    try {
      if (mode === "evidence_gate") {
        try {
          const res = await runEvidenceGate({ provider: o.providers.tool(), sandbox, view: toRepoView(c, files, tests), changed: changedLinesOf(c), limits });
          const cost = res.meta.cost_usd ?? estimateCost(res.meta.usage, o.pricing);
          return { ok: true, rec: { verdict: res.verdict, model_verdict: res.gate.model_verdict, evidence: res, latency_ms: res.meta.latency_ms }, usage: res.meta.usage, cost, source: res.meta.cost_usd === null ? "estimated" : "reported" };
        } catch (err) {
          const e = err instanceof ReviewError ? err : new ReviewError("INTERNAL_ERROR", String(err));
          const usage = e.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
          const reported = err instanceof EvidenceGateError ? err.cost_usd : null;
          return { ok: false, err: e, usage, cost: reported ?? estimateCost(usage, o.pricing), source: reported === null ? "estimated" : "reported" };
        }
      }
      const meter = new CostMeter();
      const reviewer = new Reviewer({ provider: o.providers.text(meter), maxTokensPerCall: config.maxTokensPerCall, maxReviewTokens: config.maxReviewTokens, timeoutMs: config.timeoutMs, blindnessLeakThreshold: 1.01, blindnessWarnThreshold: 1.01 });
      const input = toBaselineInput(c, files, tests);
      const costOf = (): { cost: number; source: "reported" | "estimated" } =>
        meter.callsWithoutCost === 0 && meter.calls > 0 ? { cost: meter.reported, source: "reported" } : { cost: estimateCost(meter.usage, o.pricing), source: "estimated" };
      try {
        const review = mode === "decision_judge" ? await reviewer.review(input, { benchmarkMode: "decision_judge" }) : await reviewer.review({ ...input, review_mode: "proposal_first" });
        return { ok: true, rec: { verdict: review.verdict, review, latency_ms: review.meta.latency_ms }, usage: review.meta.usage, ...costOf() };
      } catch (err) {
        const e = err instanceof ReviewError ? err : new ReviewError("INTERNAL_ERROR", String(err));
        return { ok: false, err: e, usage: e.usage ?? meter.usage, ...costOf() };
      }
    } finally {
      await sandbox.dispose();
    }
  };

  let inFlight = 0;
  let stopped = false;
  const reserveCheck = (mode: RepoMode): boolean => {
    const reserved = o.ledger.spent + inFlight * Math.max(...modes.map((m) => o.reservePerReviewUsd[m])) + o.reservePerReviewUsd[mode];
    return reserved <= o.hardStopUsd;
  };

  const runOne = async (c: RepoCase, run: number, mode: RepoMode): Promise<RepoRunRecord | null> => {
    const rec: RepoRunRecord = { case_id: c.id, run, mode, model: o.model, attempts: 0, retries: [], ok: false, usage_all_attempts: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, cost_usd_all_attempts: 0, cost_source: "reported", latency_ms: 0 };
    const sources = new Set<string>();
    for (let attempt = 0; attempt <= o.retries; attempt++) {
      if (!reserveCheck(mode)) {
        stopped = true;
        return null; // not recorded (a half-retried record would look like a failure); its cost is in the ledger

      }
      rec.attempts++;
      inFlight++;
      const t0 = performance.now();
      let r: Awaited<ReturnType<typeof once>>;
      try {
        r = await once(c, mode);
      } finally {
        inFlight--;
      }
      rec.usage_all_attempts = { prompt_tokens: rec.usage_all_attempts.prompt_tokens + r.usage.prompt_tokens, completion_tokens: rec.usage_all_attempts.completion_tokens + r.usage.completion_tokens, total_tokens: rec.usage_all_attempts.total_tokens + r.usage.total_tokens };
      rec.cost_usd_all_attempts += r.cost;
      sources.add(r.source);
      await o.ledger.add({ ts: new Date().toISOString(), label: o.label, model: o.model, mode, case_id: c.id, run, cost_usd: r.cost, source: r.source });
      if (r.ok) {
        Object.assign(rec, r.rec);
        rec.ok = true;
        return finish(rec, sources);
      }
      rec.latency_ms = Math.round(performance.now() - t0);
      const info = { code: r.err.code, message: r.err.message.slice(0, 300), ...(r.err.status !== undefined ? { status: r.err.status } : {}) };
      if (attempt < o.retries && isTransient(info)) {
        rec.retries.push(info);
        log(`  retry ${attempt + 1}/${o.retries} ${c.id} run${run} [${mode}] after ${info.code}${info.status ? ` ${info.status}` : ""}`);
        await new Promise((res) => setTimeout(res, (o.retryDelayMs ?? 5000) * (attempt + 1) * (info.status === 429 ? 6 : 1)));
        continue;
      }
      rec.error = info;
      return finish(rec, sources);
    }
    return finish(rec, sources);
  };
  const finish = (rec: RepoRunRecord, sources: Set<string>): RepoRunRecord => {
    rec.cost_source = sources.size > 1 ? "mixed" : ((sources.values().next().value as RepoRunRecord["cost_source"] | undefined) ?? "reported");
    return rec;
  };

  const queue: Array<{ c: RepoCase; run: number; mode: RepoMode }> = [];
  for (const u of units) for (const m of u.order) if (!done.has(key(u.c.id, u.run, m))) queue.push({ c: u.c, run: u.run, mode: m });
  let next = 0;
  const worker = async () => {
    while (next < queue.length && !stopped) {
      const job = queue[next++] as (typeof queue)[number];
      const r = await runOne(job.c, job.run, job.mode);
      if (!r) break;
      records.push(r);
      await o.onRecord?.(r);
      const extra = r.mode === "evidence_gate" && r.evidence ? ` model=${r.model_verdict} gate=${r.evidence.gate.status} tools=${r.evidence.tool_log.length}` : "";
      log(`${r.case_id} run${r.run} [${r.mode}] ${r.ok ? r.verdict : `FAILED ${r.error?.code}`}${extra} $${r.cost_usd_all_attempts.toFixed(5)} · total $${o.ledger.spent.toFixed(4)}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker));
  if (stopped) throw new BudgetStop(o.ledger.spent, records.length, expected);
  records.sort((a, b) => a.case_id.localeCompare(b.case_id) || a.run - b.run || a.mode.localeCompare(b.mode));
  return {
    schema: "blindreview-repo-benchmark/v1",
    label: o.label,
    created_at: new Date().toISOString(),
    git,
    model: o.model,
    base_url_host: (() => {
      try {
        return new URL(config.baseUrl).host;
      } catch {
        return "invalid-url";
      }
    })(),
    config: { evidence_limits: limits, text_max_review_tokens: config.maxReviewTokens, text_max_tokens_per_call: config.maxTokensPerCall, reasoning_effort: config.reasoningEffort ?? null, temperature: config.temperature ?? null, retries: o.retries, concurrency: o.concurrency },
    pricing: o.pricing,
    case_set_hash: o.caseSetHash,
    case_count: cases.length,
    prompt_hashes: promptHashes(),
    modes,
    runs: o.runs,
    seed: o.seed,
    records,
  };
}
