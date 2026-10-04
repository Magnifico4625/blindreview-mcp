// @ts-check
import { createSubscription } from "./service.js";

/**
 * Single validation point for subscription requests.
 * @param {unknown} body
 * @returns {{ email: string, quantity: number }}
 */
export function parseSubscriptionRequest(body) {
  if (typeof body !== "object" || body === null) throw new Error("400: body must be an object");
  const b = /** @type {Record<string, unknown>} */ (body);
  if (typeof b.email !== "string" || !b.email.includes("@")) throw new Error("400: invalid email");
  if (typeof b.quantity !== "number" || !Number.isInteger(b.quantity) || b.quantity < 1 || b.quantity > 100) throw new Error("400: invalid quantity");
  return { email: b.email, quantity: b.quantity };
}

/** @param {unknown} body */
export function handlePostSubscription(body) {
  return createSubscription(parseSubscriptionRequest(body));
}
