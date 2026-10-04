import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Usage } from "../../src/schemas/review.js";

/** Per-token USD prices (OpenRouter /models `pricing.prompt` / `pricing.completion`). */
export interface Pricing {
  prompt: number;
  completion: number;
}

export async function fetchOpenRouterPricing(model: string, fetchImpl: typeof fetch = fetch): Promise<Pricing> {
  const res = await fetchImpl("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`OpenRouter /models HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id: string; pricing?: { prompt?: string; completion?: string }; supported_parameters?: string[] }> };
  const m = body.data?.find((x) => x.id === model);
  if (!m) throw new Error(`model ${model} not found on OpenRouter`);
  if (!m.supported_parameters?.includes("tools")) throw new Error(`model ${model} does not list tool calling support`);
  return { prompt: Number(m.pricing?.prompt ?? NaN), completion: Number(m.pricing?.completion ?? NaN) };
}

export function estimateCost(u: Usage, p: Pricing): number {
  return u.prompt_tokens * p.prompt + u.completion_tokens * p.completion;
}

/** Accumulates gateway-reported cost (usage.cost) and tokens of every response that passes through. */
export class CostMeter {
  reported = 0;
  calls = 0;
  callsWithoutCost = 0;
  usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  /** fetch wrapper for providers that do not surface cost themselves (the v0.3 Reviewer path). */
  wrap(inner: typeof fetch = fetch): typeof fetch {
    return async (input, init) => {
      const res = await inner(input, init);
      try {
        const body = (await res.clone().json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number } };
        this.add(body.usage);
      } catch {
        // non-JSON error bodies: nothing to meter
      }
      return res;
    };
  }

  add(u: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number } | undefined): void {
    this.calls++;
    if (!u) {
      this.callsWithoutCost++;
      return;
    }
    const p = u.prompt_tokens ?? 0;
    const c = u.completion_tokens ?? 0;
    this.usage.prompt_tokens += p;
    this.usage.completion_tokens += c;
    this.usage.total_tokens += u.total_tokens ?? p + c;
    if (typeof u.cost === "number") this.reported += u.cost;
    else this.callsWithoutCost++;
  }
}

export interface LedgerEntry {
  ts: string;
  label: string;
  model: string;
  mode: string;
  case_id: string;
  run: number;
  cost_usd: number;
  source: "reported" | "estimated";
}

/** Append-only spend ledger shared by all v0.4.0 runs (cumulative budget across invocations). */
export class SpendLedger {
  private total = 0;
  private loaded = false;
  constructor(readonly file: string) {}

  async load(): Promise<number> {
    const text = await readFile(this.file, "utf8").catch(() => "");
    this.total = text
      .split("\n")
      .filter(Boolean)
      .reduce((s, l) => s + (JSON.parse(l) as LedgerEntry).cost_usd, 0);
    this.loaded = true;
    return this.total;
  }

  get spent(): number {
    if (!this.loaded) throw new Error("ledger not loaded");
    return this.total;
  }

  async add(e: LedgerEntry): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(e)}\n`, "utf8");
    this.total += e.cost_usd;
  }
}
