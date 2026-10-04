import type { Config } from "../src/config.js";
import type { ReviewerProvider } from "../src/providers/provider.js";
import { promptHashes } from "../src/reviewer/prompt-fingerprint.js";
import { Reviewer } from "../src/reviewer/reviewer.js";
import { REVIEW_MODES, ReviewError, type AnyMode, type BenchmarkOnlyMode, type ReviewMode, type Usage } from "../src/schemas/review.js";
import { toReviewInput, type BenchmarkCase } from "./cases.js";
import { gitInfo } from "./meta.js";
import { compareCriticBias, compareModes, computeModeMetrics, type Comparison, type ModeMetrics, type RunRecord } from "./metrics.js";
import { rng, shuffle } from "./stats.js";

export const MAIN_MODES: readonly AnyMode[] = ["proposal_first", "proposal_first_2pass", "blind_first", "independent_only"];
export const EXPERIMENT_MODES: readonly AnyMode[] = ["decision_judge"];
export const DEFAULT_MODES: readonly AnyMode[] = [...MAIN_MODES, ...EXPERIMENT_MODES];
export const TRANSIENT_CODES = new Set(["TIMEOUT", "PROVIDER_NETWORK_ERROR"]);

export interface BenchmarkOptions {
  label: string;
  modes?: readonly AnyMode[];
  runs?: number;
  seed?: number;
  concurrency?: number;
  /** Retries per review for transient errors (timeouts, network, HTTP 429/5xx). Default 2. */
  retries?: number;
  retryDelayMs?: number;
  caseSetHash: string;
  provider: ReviewerProvider;
  log?: (msg: string) => void;
  /** Called after every finished (case, run, mode) record, e.g. to append it to a checkpoint file. */
  onRecord?: (record: RunRecord) => void | Promise<void>;
  /** Records from an interrupted run (same config); their (case, run, mode) keys are not re-run. */
  resumeRecords?: RunRecord[];
  /**
   * Stop starting new work when a review finally fails with HTTP 429 (e.g. a daily free-model cap).
   * The 429 record is not kept/checkpointed; runBenchmark then throws RateLimitStop so the run can be resumed.
   */
  stopOnRateLimit?: boolean;
}

export class RateLimitStop extends Error {
  constructor(
    readonly completed: number,
    readonly expected: number,
  ) {
    super(`stopped on HTTP 429 after ${completed}/${expected} records; rerun with --resume later`);
  }
}

/** Records worth reusing on resume: successes and non-transient failures (transient failures are re-run). */
export function reusableOnResume(r: RunRecord): boolean {
  return r.ok || !(r.error && (TRANSIENT_CODES.has(r.error.code) || r.error.status === 429 || (r.error.status ?? 0) >= 500));
}

export interface BenchmarkReport {
  schema: "blindreview-benchmark/v3";
  label: string;
  created_at: string;
  git: { sha: string | null; dirty: boolean | null };
  provider: string;
  base_url_host: string;
  model: string;
  config: {
    reasoning_effort: string | null;
    reasoning_param: string | null;
    temperature: number | null;
    max_tokens_per_call: number;
    max_review_tokens: number;
    timeout_ms: number;
    retries: number;
    concurrency: number;
  };
  case_set_hash: string;
  case_count: number;
  prompt_hashes: Record<string, string>;
  modes: AnyMode[];
  runs: number;
  seed: number;
  records: RunRecord[];
  metrics: ModeMetrics[];
  comparisons: Comparison[];
}

function isTransient(err: unknown): boolean {
  if (!(err instanceof ReviewError)) return false;
  if (TRANSIENT_CODES.has(err.code)) return true;
  return err.code === "PROVIDER_HTTP_ERROR" && err.status !== undefined && (err.status === 429 || err.status >= 500);
}

const addUsage = (a: Usage, b: Usage | undefined): Usage =>
  b ? { prompt_tokens: a.prompt_tokens + b.prompt_tokens, completion_tokens: a.completion_tokens + b.completion_tokens, total_tokens: a.total_tokens + b.total_tokens } : a;

export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

export async function runBenchmark(cases: BenchmarkCase[], config: Config, options: BenchmarkOptions): Promise<BenchmarkReport> {
  const modes = [...(options.modes ?? DEFAULT_MODES)];
  const runs = Math.max(1, options.runs ?? 3);
  const seed = options.seed ?? 42;
  const retries = Math.max(0, options.retries ?? 2);
  const retryDelayMs = options.retryDelayMs ?? 5000;
  const log = options.log ?? (() => {});
  const random = rng(seed);
  const provider = options.provider;

  const units: Array<{ c: BenchmarkCase; run: number; order: AnyMode[] }> = [];
  for (let run = 1; run <= runs; run++) for (const c of cases) units.push({ c, run, order: shuffle(modes, random) });

  const reviewOnce = async (c: BenchmarkCase, mode: AnyMode) => {
    const reviewer = new Reviewer({
      provider,
      maxTokensPerCall: config.maxTokensPerCall,
      maxReviewTokens: config.maxReviewTokens,
      timeoutMs: config.timeoutMs,
      blindnessLeakThreshold: config.blindnessLeakThreshold,
      blindnessWarnThreshold: config.blindnessWarnThreshold,
    });
    const input = toReviewInput(c);
    if ((REVIEW_MODES as readonly string[]).includes(mode)) {
      input.review_mode = mode as ReviewMode;
      return reviewer.review(input);
    }
    return reviewer.review(input, { benchmarkMode: mode as BenchmarkOnlyMode });
  };

  const reviewWithRetries = async (c: BenchmarkCase, run: number, mode: AnyMode): Promise<RunRecord> => {
    const record: RunRecord = {
      case_id: c.id,
      run,
      mode,
      attempts: 0,
      retries: [],
      ok: false,
      usage_all_attempts: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      latency_ms: 0,
    };
    for (let attempt = 0; attempt <= retries; attempt++) {
      record.attempts++;
      const started = performance.now();
      try {
        const result = await reviewOnce(c, mode);
        record.ok = true;
        record.result = result;
        record.latency_ms = result.meta.latency_ms;
        record.usage_all_attempts = addUsage(record.usage_all_attempts, result.meta.usage);
        return record;
      } catch (err) {
        const e = err instanceof ReviewError ? err : new ReviewError("INTERNAL_ERROR", String(err));
        record.usage_all_attempts = addUsage(record.usage_all_attempts, e.usage);
        record.latency_ms = Math.round(performance.now() - started);
        const info = { code: e.code, message: e.message.slice(0, 300), ...(e.status !== undefined ? { status: e.status } : {}) };
        if (attempt < retries && isTransient(e)) {
          record.retries.push(info);
          log(`  retry ${attempt + 1}/${retries} ${c.id} run${run} [${mode}] after ${e.code}`);
          // 429 (per-minute limits) gets a 6x longer backoff than timeouts / 5xx.
          await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1) * (e.status === 429 ? 6 : 1)));
          continue;
        }
        record.error = info;
        return record;
      }
    }
    return record;
  };

  const key = (caseId: string, run: number, mode: string) => `${caseId}\u0000${run}\u0000${mode}`;
  const records: RunRecord[] = [];
  const done = new Set<string>();
  const known = new Set(units.flatMap((u) => modes.map((m) => key(u.c.id, u.run, m))));
  for (const r of options.resumeRecords ?? []) {
    const k = key(r.case_id, r.run, r.mode);
    if (known.has(k) && !done.has(k) && reusableOnResume(r)) {
      done.add(k);
      records.push(r);
    }
  }
  if (done.size) log(`resuming: ${done.size} records reused from checkpoint`);
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (next < units.length && !stopped) {
      const unit = units[next++] as (typeof units)[number];
      for (const mode of unit.order) {
        if (done.has(key(unit.c.id, unit.run, mode))) continue;
        if (stopped) break;
        const r = await reviewWithRetries(unit.c, unit.run, mode);
        if (options.stopOnRateLimit && r.error?.status === 429) {
          stopped = true;
          log(`${unit.c.id} run${unit.run} [${mode}] HTTP 429 after retries: stopping (record not kept)`);
          break;
        }
        records.push(r);
        await options.onRecord?.(r);
        log(
          `${unit.c.id} run${unit.run} [${mode}] ${r.ok ? `${r.result?.verdict} tokens=${r.result?.meta.usage.total_tokens} ${r.latency_ms}ms` : `FAILED ${r.error?.code}`}${r.retries.length ? ` (retries: ${r.retries.length})` : ""}`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 1) }, worker));
  if (stopped) throw new RateLimitStop(records.length, units.length * modes.length);
  records.sort((a, b) => a.case_id.localeCompare(b.case_id) || a.run - b.run || a.mode.localeCompare(b.mode));

  const comparisons: Comparison[] = [];
  const has = (m: AnyMode) => modes.includes(m);
  if (has("blind_first") && has("proposal_first")) comparisons.push(compareModes("Q1", "blind_first", "proposal_first", cases, records, seed));
  if (has("blind_first") && has("proposal_first_2pass")) comparisons.push(compareModes("Q2", "blind_first", "proposal_first_2pass", cases, records, seed));
  if (has("independent_only") && has("blind_first")) comparisons.push(compareModes("Q3", "independent_only", "blind_first", cases, records, seed));
  if (has("decision_judge") && has("proposal_first")) comparisons.push(compareCriticBias("Q4", "decision_judge", "proposal_first", cases, records, seed));

  return {
    schema: "blindreview-benchmark/v3",
    label: options.label,
    created_at: new Date().toISOString(),
    git: gitInfo(),
    provider: provider.name,
    base_url_host: safeHost(config.baseUrl),
    model: provider.model,
    config: {
      reasoning_effort: config.reasoningEffort ?? null,
      reasoning_param: config.reasoningParam ?? null,
      temperature: config.temperature ?? null,
      max_tokens_per_call: config.maxTokensPerCall,
      max_review_tokens: config.maxReviewTokens,
      timeout_ms: config.timeoutMs,
      retries,
      concurrency: Math.max(1, options.concurrency ?? 1),
    },
    case_set_hash: options.caseSetHash,
    case_count: cases.length,
    prompt_hashes: promptHashes(),
    modes,
    runs,
    seed,
    records,
    metrics: modes.map((m) => computeModeMetrics(m, cases, records)),
    comparisons,
  };
}

/** Windows-safe timestamp for file names (no ':' characters). */
export function fileTimestamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-");
}
