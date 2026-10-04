// @ts-check

/** @typedef {"pending" | "paid" | "shipped"} OrderStatus */
/** @typedef {{ id: string, status: OrderStatus, totalCents: number }} Order */
/** @typedef {{ orderId: string, amountCents: number, at: number }} RefundEntry */

/**
 * Refunds are recorded in the refund ledger; the order status no longer changes.
 * @param {Order} order
 * @param {RefundEntry[]} ledger
 * @param {number} now
 * @returns {RefundEntry}
 */
export function recordRefund(order, ledger, now) {
  const entry = { orderId: order.id, amountCents: order.totalCents, at: now };
  ledger.push(entry);
  return entry;
}
