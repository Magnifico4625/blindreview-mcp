import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFlags, parseBool } from "../src/flags.js";

test("flags default to off", () => assert.deepEqual(loadFlags({}), { searchV2: false, newCheckout: false }));
test("parseBool", () => {
  assert.equal(parseBool("TRUE", false), true);
  assert.equal(parseBool("0", true), false);
  assert.equal(parseBool(undefined, true), true);
});

test("new checkout flag can be enabled", () => assert.equal(loadFlags({ FLAG_NEW_CHECKOUT: "on" }).newCheckout, true));
