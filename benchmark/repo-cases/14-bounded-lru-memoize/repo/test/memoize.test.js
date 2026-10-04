import { test } from "node:test";
import assert from "node:assert/strict";
import { memoize } from "../src/memoize.js";

test("caches results", () => {
  let calls = 0;
  const f = memoize((x) => { calls++; return x * 2; });
  assert.equal(f(2), 4);
  assert.equal(f(2), 4);
  assert.equal(calls, 1);
});

test("evicts the least recently used entry", () => {
  let calls = 0;
  const f = memoize((x) => { calls++; return x; }, 2);
  f(1); f(2);
  f(1);          // 1 becomes most recent
  f(3);          // evicts 2
  f(1);          // still cached
  assert.equal(calls, 3);
  f(2);          // recomputed
  assert.equal(calls, 4);
});
