import { test } from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/retry.js";

const noSleep = async () => {};

test("returns the first successful result", async () => {
  let calls = 0;
  const value = await retry(async () => {
    calls++;
    if (calls < 2) throw new Error("boom");
    return "ok";
  }, { attempts: 3, baseDelayMs: 1, sleep: noSleep });
  assert.equal(value, "ok");
  assert.equal(calls, 2);
});

test("makes exactly `attempts` calls when every call fails", async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => {
      calls++;
      throw new Error("down");
    }, { attempts: 3, baseDelayMs: 1, sleep: noSleep }),
  );
  assert.equal(calls, 3);
});
