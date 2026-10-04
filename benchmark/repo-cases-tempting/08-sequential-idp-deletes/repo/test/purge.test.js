import { test } from "node:test";
import assert from "node:assert/strict";
import { purgeUsers } from "../src/purge.js";

test("deletes all", async () => {
  const deleted = [];
  assert.equal(await purgeUsers({ deleteUser: async (id) => { deleted.push(id); } }, ["a", "b"]), 2);
  assert.deepEqual(deleted.sort(), ["a", "b"]);
});

test("never more than one request in flight", async () => {
  let inFlight = 0, max = 0;
  const api = { deleteUser: async () => { inFlight++; max = Math.max(max, inFlight); await new Promise((r) => setTimeout(r, 2)); inFlight--; } };
  await purgeUsers(api, ["a", "b", "c", "d"]);
  assert.equal(max, 1);
});
