// @ts-check

/**
 * @param {import("./flags.js").Flags} flags
 * @param {{ items: number }} cart
 */
export function checkoutPage(flags, cart) {
  return { template: flags.newCheckout ? "checkout-v2" : "checkout-v1", items: cart.items };
}
