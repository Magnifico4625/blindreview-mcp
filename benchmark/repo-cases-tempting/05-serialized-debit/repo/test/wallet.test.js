import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createWallet } from "../src/wallet.js";

test("concurrent credits are not lost", async () => {
  const store = createStore();
  const w = createWallet(store);
  await Promise.all(Array.from({ length: 50 }, () => w.credit("a", 1)));
  assert.equal(await store.get("a"), 50);
});

test("concurrent debits never overdraw", async () => {
  const store = createStore();
  const w = createWallet(store);
  await w.credit("a", 5);
  const results = await Promise.all(Array.from({ length: 10 }, () => w.debit("a", 1)));
  assert.equal(results.filter(Boolean).length, 5);
  assert.equal(await store.get("a"), 0);
});
