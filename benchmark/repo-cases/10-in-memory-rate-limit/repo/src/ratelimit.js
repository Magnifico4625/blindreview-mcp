// @ts-check

/**
 * Fixed-window rate limiter with in-process counters (no network round trip).
 * @param {{ limit: number, windowSeconds: number, now?: () => number }} opts
 */
export function createRateLimiter(opts) {
  const now = opts.now ?? Date.now;
  /** @type {Map<string, number>} */
  const counters = new Map();
  let currentWindow = -1;
  /** @param {string} apiKey */
  return async function allow(apiKey) {
    const window = Math.floor(now() / 1000 / opts.windowSeconds);
    if (window !== currentWindow) {
      counters.clear();
      currentWindow = window;
    }
    const count = (counters.get(apiKey) ?? 0) + 1;
    counters.set(apiKey, count);
    return count <= opts.limit;
  };
}
