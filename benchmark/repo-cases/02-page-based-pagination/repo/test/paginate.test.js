import { test } from "node:test";
import assert from "node:assert/strict";
import { clampLimit, paginate } from "../src/paginate.js";

test("clampLimit defaults and caps", () => {
  assert.equal(clampLimit(undefined), 20);
  assert.equal(clampLimit("500"), 100);
  assert.equal(clampLimit("abc"), 20);
});

test("paginate slices", () => {
  assert.deepEqual(paginate([1, 2, 3, 4], 1, 2), { items: [2, 3], total: 4 });
});
