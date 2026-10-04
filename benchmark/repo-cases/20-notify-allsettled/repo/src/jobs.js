// @ts-check
import { notifyAll } from "./notify.js";

/**
 * Queue job handler for "order shipped" notifications.
 * @param {import("./notify.js").Channel[]} channels
 * @param {{ userId: string, orderId: string }} payload
 * @param {import("./notify.js").Logger} logger
 */
export async function onOrderShipped(channels, payload, logger) {
  await notifyAll(channels, payload.userId, `Order ${payload.orderId} has shipped`, logger);
}
