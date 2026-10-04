import { test } from "node:test";
import assert from "node:assert/strict";
import { createTelemetry } from "../src/telemetry.js";

test("sends events", async () => {
  const sent = [];
  const t = createTelemetry({ send: async (e) => { sent.push(e); } });
  await t.track({ type: "x" });
  assert.equal(sent.length, 1);
});

test("a failing transport does not fail the request and is counted", async () => {
  const { placeOrder } = await import("../src/orders.js");
  const t = createTelemetry({ send: async () => { throw new Error("analytics down"); } });
  assert.deepEqual(await placeOrder(t, { id: "o1" }), { ok: true, id: "o1" });
  assert.equal(t.droppedEvents(), 1);
});
