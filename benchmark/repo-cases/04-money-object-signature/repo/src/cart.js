// @ts-check
import { formatPrice } from "./money.js";

/**
 * @param {Array<{ cents: number, qty: number }>} lines
 * @param {string} currency
 */
export function cartTotalLabel(lines, currency) {
  const total = lines.reduce((sum, l) => sum + l.cents * l.qty, 0);
  return `Total: ${formatPrice({ cents: total, currency })}`;
}
