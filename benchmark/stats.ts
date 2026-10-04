/** Small, dependency-free statistics helpers for the benchmark. */

export interface Rate {
  k: number;
  n: number;
  rate: number | null;
  /** 95% Wilson score interval. */
  ci95: [number, number] | null;
}

export function wilson(k: number, n: number, z = 1.96): Rate {
  if (n === 0) return { k, n, rate: null, ci95: null };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { k, n, rate: round(p), ci95: [round(Math.max(0, centre - half)), round(Math.min(1, centre + half))] };
}

export interface Spread {
  n: number;
  mean: number | null;
  sd: number | null;
  min: number | null;
  max: number | null;
}

export function spread(xs: number[]): Spread {
  if (!xs.length) return { n: 0, mean: null, sd: null, min: null, max: null };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) : 0;
  return { n: xs.length, mean: round(mean), sd: round(sd), min: Math.min(...xs), max: Math.max(...xs) };
}

export function round(x: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Deterministic PRNG (mulberry32) for reproducible mode order. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

export function fmtRate(r: Rate): string {
  if (r.rate === null || !r.ci95) return "-";
  return `${r.k}/${r.n} (${Math.round(r.rate * 100)}%, CI ${Math.round(r.ci95[0] * 100)}-${Math.round(r.ci95[1] * 100)}%)`;
}

export function fmtSpread(s: Spread, unit = ""): string {
  if (s.mean === null) return "-";
  return `${Math.round(s.mean)}${unit} ± ${Math.round(s.sd ?? 0)}`;
}
