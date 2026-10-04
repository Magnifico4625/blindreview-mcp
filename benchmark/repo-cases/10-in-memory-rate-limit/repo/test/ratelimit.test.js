import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../src/ratelimit.js";

test("allows up to the limit per window", async () => {
  let t = 0;
  const allow = createRateLimiter({ limit: 2, windowSeconds: 60, now: () => t });
  assert.equal(await allow("k"), true);
  assert.equal(await allow("k"), true);
  assert.equal(await allow("k"), false);
  t = 61_000;
  assert.equal(await allow("k"), true);
});

test("keys are independent", async () => {
  const allow = createRateLimiter({ limit: 1, windowSeconds: 60, now: () => 0 });
  assert.equal(await allow("a"), true);
  assert.equal(await allow("b"), true);
});
