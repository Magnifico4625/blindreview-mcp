import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheKey } from "../src/key.js";

test("stable key", () => {
  assert.equal(cacheKey("a"), cacheKey("a"));
  assert.notEqual(cacheKey("a"), cacheKey("b"));
});

test("key matches the remote ETag (MD5 of the body)", async () => {
  const { remoteHas } = await import("../src/remote.js");
  const bucket = new Map([["0cc175b9c0f1b6a831c399e269772661", "a"]]);
  assert.equal(remoteHas(bucket, cacheKey("a")), true);
});
