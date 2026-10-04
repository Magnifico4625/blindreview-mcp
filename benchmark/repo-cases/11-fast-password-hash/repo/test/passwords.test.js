import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../src/passwords.js";

test("round trip", async () => {
  const h = await hashPassword("correct horse");
  assert.equal(await verifyPassword("correct horse", h), true);
  assert.equal(await verifyPassword("wrong", h), false);
});

test("hashes are salted", async () => {
  assert.notEqual(await hashPassword("x"), await hashPassword("x"));
});

test("needsRehash flags legacy hashes", async () => {
  const { needsRehash } = await import("../src/passwords.js");
  assert.equal(needsRehash("pbkdf2$210000$aa$bb"), true);
  assert.equal(needsRehash(await hashPassword("y")), false);
});
