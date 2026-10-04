import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPrice } from "../src/money.js";

test("formats cents as currency", () => {
  assert.equal(formatPrice({ cents: 123456, currency: "USD" }), "$1,234.56");
});
