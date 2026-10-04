import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLimit } from "../src/query.js";

test("parses numbers", () => assert.equal(parseLimit("50"), 50));
test("defaults when missing", () => assert.equal(parseLimit(undefined), 20));
test("caps at 100", () => assert.equal(parseLimit("100000"), 100));
test("rejects garbage, negatives and zero", () => {
  for (const raw of ["abc", "-5", "0", "12abc", "1e3", ""]) assert.equal(parseLimit(raw), 20, raw);
});
test("base 10 even with leading zeros", () => assert.equal(parseLimit("010"), 10));
