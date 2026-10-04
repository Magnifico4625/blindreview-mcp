// @ts-check

/**
 * Call fn until it succeeds, at most `attempts` times in total, with exponential backoff
 * and full jitter (delay is uniformly random in [0, base * 2^attempt]).
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ attempts: number, baseDelayMs: number, sleep?: (ms: number) => Promise<void>, random?: () => number }} opts
 * @returns {Promise<T>}
 */
export async function retry(fn, opts) {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  /** @type {unknown} */
  let lastError;
  for (let attempt = 0; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < opts.attempts) await sleep(Math.round(random() * opts.baseDelayMs * 2 ** attempt));
    }
  }
  throw lastError;
}
