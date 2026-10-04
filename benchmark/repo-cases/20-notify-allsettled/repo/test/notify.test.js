import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyAll } from "../src/notify.js";

const logger = () => { const warnings = []; return { warnings, warn: (m, meta) => warnings.push([m, meta]) }; };

test("sends on every channel", async () => {
  const sent = [];
  const ch = (name) => ({ name, send: async (u, m) => { sent.push([name, u, m]); } });
  const res = await notifyAll([ch("email"), ch("push")], "u1", "hi", logger());
  assert.equal(sent.length, 2);
  assert.deepEqual(res, { failed: [] });
});

test("one failing channel does not stop or fail the others", async () => {
  const sent = [];
  const log = logger();
  const ok = (name) => ({ name, send: async () => { sent.push(name); } });
  const bad = { name: "sms", send: async () => { throw new Error("gateway down"); } };
  const res = await notifyAll([ok("email"), bad, ok("push")], "u1", "hi", log);
  assert.deepEqual(sent, ["email", "push"]);
  assert.deepEqual(res, { failed: ["sms"] });
  assert.equal(log.warnings.length, 1);
});
