import { test } from "node:test";
import assert from "node:assert/strict";
import { averageOrderValueLabel, revenueCents } from "../src/report.js";

test("sums cents", () => {
  assert.equal(revenueCents([100, 250]), 350);
});

test("average order value label", () => {
  assert.equal(averageOrderValueLabel([]), "0.00");
  assert.equal(averageOrderValueLabel([1000, 1470]), "12.35");
  assert.equal(averageOrderValueLabel([1, 1, 1]), "0.01");
});
