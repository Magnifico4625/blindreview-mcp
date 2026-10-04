// @ts-check

/** @typedef {{ cents: number, currency: string }} Money */

/**
 * @param {Money} money
 * @returns {string}
 */
export function formatPrice(money) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: money.currency }).format(money.cents / 100);
}
