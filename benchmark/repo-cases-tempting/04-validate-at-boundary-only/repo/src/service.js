// @ts-check

/**
 * Internal service. Input is already validated by parseSubscriptionRequest() at the HTTP boundary
 * (the only caller); see src/http.js. Do not re-validate here.
 * @param {{ email: string, quantity: number }} input
 */
export function createSubscription(input) {
  return { email: input.email.toLowerCase(), quantity: input.quantity, status: "active" };
}
