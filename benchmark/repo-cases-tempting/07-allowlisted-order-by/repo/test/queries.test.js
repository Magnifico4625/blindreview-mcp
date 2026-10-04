import { test } from "node:test";
import assert from "node:assert/strict";
import { listInvoicesQuery } from "../src/queries.js";

test("parameterized status", () => {
  const q = listInvoicesQuery({ status: "paid" });
  assert.deepEqual(q.values, ["paid"]);
  assert.match(q.text, /ORDER BY created_at DESC$/);
});

test("sort by allowlisted column", () => {
  assert.match(listInvoicesQuery({ status: "paid", sort: "total", dir: "asc" }).text, /ORDER BY total ASC$/);
});

test("injection attempts fall back to the default", () => {
  const q = listInvoicesQuery({ status: "x", sort: "created_at; DROP TABLE invoices", dir: "desc; --" });
  assert.match(q.text, /ORDER BY created_at DESC$/);
  assert.doesNotMatch(q.text, /DROP/);
  assert.match(listInvoicesQuery({ status: "x", sort: "__proto__" }).text, /ORDER BY created_at DESC$/);
  assert.match(listInvoicesQuery({ status: "x", sort: "toString" }).text, /ORDER BY created_at DESC$/);
});
