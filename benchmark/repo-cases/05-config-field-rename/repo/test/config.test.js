import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("defaults", () => {
  const c = loadConfig({});
  assert.equal(c.baseUrl, "http://localhost:8080");
  assert.equal(c.requestTimeoutMs, 5000);
});
