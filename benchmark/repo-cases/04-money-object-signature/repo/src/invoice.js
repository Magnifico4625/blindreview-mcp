// @ts-check
import { formatPrice } from "./money.js";

/**
 * Render invoice lines for the PDF generator.
 * @param {{ currency: string, lines: Array<{ label: string, cents: number }> }} invoice
 * @returns {string[]}
 */
export function invoiceLines(invoice) {
  return invoice.lines.map((line) => `${line.label}  ${formatPrice(line.cents, invoice.currency)}`);
}
