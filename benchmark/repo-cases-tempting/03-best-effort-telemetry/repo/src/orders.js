// @ts-check

/**
 * @param {{ track: (e: object) => Promise<void> }} telemetry
 * @param {{ id: string }} order
 */
export async function placeOrder(telemetry, order) {
  await telemetry.track({ type: "order_placed", id: order.id });
  return { ok: true, id: order.id };
}
