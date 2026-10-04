import { test } from "node:test";
import assert from "node:assert/strict";
import { debounce } from "../src/debounce.js";

function fakeTimers() {
  let id = 0;
  const pending = new Map();
  return {
    setTimer: (cb) => { id++; pending.set(id, cb); return id; },
    clearTimer: (h) => { pending.delete(h); },
    flush: () => { const cbs = [...pending.values()]; pending.clear(); cbs.forEach((cb) => cb()); },
  };
}

test("calls fn with the latest arguments", () => {
  const t = fakeTimers();
  const calls = [];
  const d = debounce((x) => calls.push(x), 100, t);
  d(1);
  t.flush();
  assert.deepEqual(calls, [1]);
});

test("only the last call in a burst fires", () => {
  const t = fakeTimers();
  const calls = [];
  const d = debounce((x) => calls.push(x), 100, t);
  d(1);
  d(2);
  d(3);
  t.flush();
  assert.deepEqual(calls, [3]);
});
