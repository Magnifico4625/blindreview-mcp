import { test } from "node:test";
import assert from "node:assert/strict";
import { cartTotalLabel } from "../src/cart.js";

test("cart total label", () => {
  assert.equal(cartTotalLabel([{ cents: 250, qty: 2 }], "USD"), "Total: $5.00");
});
