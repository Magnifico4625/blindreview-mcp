// @ts-check

/** In-memory stand-in for the balances table. */
export function createStore() {
  /** @type {Map<string, number>} */
  const balances = new Map();
  return {
    /** @param {string} id */
    async get(id) { await Promise.resolve(); return balances.get(id) ?? 0; },
    /** @param {string} id @param {number} v */
    async set(id, v) { await Promise.resolve(); balances.set(id, v); },
  };
}
