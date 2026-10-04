// @ts-check

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/**
 * Parse the ?limit= query parameter: base-10 integer in [1, MAX_LIMIT]; anything else → DEFAULT_LIMIT.
 * @param {string | undefined} raw
 * @returns {number}
 */
export function parseLimit(raw) {
  if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}
