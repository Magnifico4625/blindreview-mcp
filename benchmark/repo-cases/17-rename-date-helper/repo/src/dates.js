// @ts-check

/**
 * @param {Date} d
 * @returns {string} YYYY-MM-DD (UTC)
 */
export function formatIsoDate(d) {
  return d.toISOString().slice(0, 10);
}
