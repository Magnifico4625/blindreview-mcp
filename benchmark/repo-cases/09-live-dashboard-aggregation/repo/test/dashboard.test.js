import { test } from "node:test";
import assert from "node:assert/strict";
import { getDashboard } from "../src/dashboard.js";

const db = {
  dailyStats: () => undefined,
  ordersForUser: () => [{ totalCents: 300, createdAt: "x" }, { totalCents: 400, createdAt: "y" }],
};

test("computes stats live from orders", () => {
  const d = getDashboard(db, "u1", () => new Date("2026-01-01T00:00:00.000Z"));
  assert.deepEqual(d, { orders: 2, revenueCents: 700, updatedAt: "2026-01-01T00:00:00.000Z" });
});
