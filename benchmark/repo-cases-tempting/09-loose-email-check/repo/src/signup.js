// @ts-check
import { isPlausibleEmail } from "./email.js";

/**
 * @param {string} email
 * @param {(to: string) => Promise<void>} sendConfirmation
 */
export async function signUp(email, sendConfirmation) {
  if (!isPlausibleEmail(email)) return { ok: false, error: "Please check the email address." };
  await sendConfirmation(email); // account stays unconfirmed until the link is clicked
  return { ok: true, status: "pending_confirmation" };
}
