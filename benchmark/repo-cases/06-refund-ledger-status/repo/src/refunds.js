// @ts-check
import { recordRefund } from "./orders.js";

/**
 * Refund an order. Must never refund the same order twice.
 * @param {import("./orders.js").Order} order
 * @param {(orderId: string, cents: number) => void} payout
 * @param {import("./orders.js").RefundEntry[]} ledger
 * @param {number} now
 */
export function refundOrder(order, payout, ledger, now) {
  if (order.status === "refunded") throw new Error(`order ${order.id} already refunded`);
  if (order.status === "pending") throw new Error(`order ${order.id} was never paid`);
  payout(order.id, order.totalCents);
  return recordRefund(order, ledger, now);
}
