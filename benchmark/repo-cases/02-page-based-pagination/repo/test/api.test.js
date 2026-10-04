import { test } from "node:test";
import assert from "node:assert/strict";
import { listProducts } from "../src/api.js";

const products = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `p${i + 1}` }));

test("returns the first 20 products by default", () => {
  const res = listProducts(products, {});
  assert.equal(res.items.length, 20);
  assert.equal(res.items[0]?.id, 1);
  assert.equal(res.total, 50);
});

test("legacy offset/limit still works", () => {
  const res = listProducts(products, { offset: "10", limit: "5" });
  assert.deepEqual(res.items.map((p) => p.id), [11, 12, 13, 14, 15]);
});
