import { test } from "node:test";
import assert from "node:assert/strict";
import { isPlausibleEmail } from "../src/email.js";

test("accepts real-world addresses", () => {
  for (const e of ["ann@example.com", "Ann.Lee@Example.COM", "a+tag@sub.example.co.uk", "josé@bücher.de", "x@localhost.dev", "o'brien@example.ie"]) assert.equal(isPlausibleEmail(e), true, e);
});

test("rejects obvious typos", () => {
  for (const e of ["", "annexample.com", "@example.com", "ann@", "ann @example.com"]) assert.equal(isPlausibleEmail(e), false, e);
});
