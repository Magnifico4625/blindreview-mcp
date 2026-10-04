import { test } from "node:test";
import assert from "node:assert/strict";
import { checkoutPage } from "../src/checkout.js";

test("v1 by default, v2 behind the flag", () => {
  assert.equal(checkoutPage({ searchV2: false, newCheckout: false }, { items: 1 }).template, "checkout-v1");
  assert.equal(checkoutPage({ searchV2: false, newCheckout: true }, { items: 1 }).template, "checkout-v2");
});
