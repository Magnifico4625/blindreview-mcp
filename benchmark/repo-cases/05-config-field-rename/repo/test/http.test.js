import { test } from "node:test";
import assert from "node:assert/strict";
import { requestOptions } from "../src/http.js";

test("request options", () => {
  const o = requestOptions({ baseUrl: "http://x", requestTimeoutMs: 100, retries: 1 }, "/a");
  assert.deepEqual(o, { url: "http://x/a", timeout: 100, retries: 1 });
});
