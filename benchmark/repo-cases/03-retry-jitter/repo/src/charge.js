// @ts-check
import { retry } from "./retry.js";

/**
 * Charge a card through the payment provider. The provider allows at most 3 attempts per charge
 * request; more attempts are treated as abuse and the merchant account gets throttled.
 * @param {(amountCents: number) => Promise<string>} providerCharge
 * @param {number} amountCents
 */
export function chargeWithRetry(providerCharge, amountCents) {
  return retry(() => providerCharge(amountCents), { attempts: 3, baseDelayMs: 200 });
}
