import { test } from "node:test";
import assert from "node:assert/strict";
import { handlePostSubscription } from "../src/http.js";

test("creates a subscription", () => {
  assert.deepEqual(handlePostSubscription({ email: "A@x.io", quantity: 2 }), { email: "a@x.io", quantity: 2, status: "active" });
});

test("rejects invalid input at the boundary", () => {
  assert.throws(() => handlePostSubscription({ email: "nope", quantity: 2 }), /400/);
  assert.throws(() => handlePostSubscription({ email: "a@x.io", quantity: 0 }), /400/);
  assert.throws(() => handlePostSubscription({ email: "a@x.io", quantity: 2.5 }), /400/);
  assert.throws(() => handlePostSubscription(null), /400/);
});
