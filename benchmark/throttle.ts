import type { CompletionRequest, CompletionResponse, ReviewerProvider } from "../src/providers/provider.js";

/**
 * Wraps a provider: at most `maxPerMinute` request starts per rolling minute (0 = unlimited), and counts calls.
 * Used for free models with per-minute / per-day request limits.
 */
export class ThrottledProvider implements ReviewerProvider {
  readonly name: string;
  readonly model: string;
  calls = 0;
  private starts: number[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly inner: ReviewerProvider,
    private readonly maxPerMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.name = inner.name;
    this.model = inner.model;
  }

  private async slot(): Promise<void> {
    if (this.maxPerMinute <= 0) return;
    for (;;) {
      const t = this.now();
      this.starts = this.starts.filter((s) => t - s < 60_000);
      if (this.starts.length < this.maxPerMinute) {
        this.starts.push(t);
        return;
      }
      await this.sleep(60_000 - (t - this.starts[0]!) + 10);
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const mine = this.chain.then(() => this.slot());
    this.chain = mine.catch(() => {});
    await mine;
    this.calls++;
    return this.inner.complete(request);
  }
}
