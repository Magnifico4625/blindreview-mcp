// @ts-check

/**
 * @template T
 * @param {T[]} items
 * @param {number} offset
 * @param {number} limit
 * @returns {{ items: T[], total: number }}
 */
export function paginate(items, offset, limit) {
  return { items: items.slice(offset, offset + limit), total: items.length };
}

/**
 * @param {unknown} raw
 * @returns {number}
 */
export function clampLimit(raw) {
  const n = Number(raw ?? 20);
  if (!Number.isInteger(n) || n < 1) return 20;
  return Math.min(n, 100);
}
