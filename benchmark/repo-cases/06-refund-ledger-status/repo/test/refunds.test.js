import { test } from "node:test";
import assert from "node:assert/strict";
import { refundOrder } from "../src/refunds.js";

test("refunds a paid order and records it in the ledger", () => {
  const paid = [];
  const ledger = [];
  const entry = refundOrder({ id: "o1", status: "paid", totalCents: 500 }, (id, c) => paid.push([id, c]), ledger, 1000);
  assert.deepEqual(paid, [["o1", 500]]);
  assert.deepEqual(ledger, [entry]);
});

test("rejects pending orders", () => {
  assert.throws(() => refundOrder({ id: "o2", status: "pending", totalCents: 1 }, () => {}, [], 0));
});
