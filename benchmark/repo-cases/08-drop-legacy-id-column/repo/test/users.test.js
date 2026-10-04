import { test } from "node:test";
import assert from "node:assert/strict";
import { toApiUser } from "../src/users.js";

test("maps row", () => {
  assert.deepEqual(toApiUser({ id: 1, email: "a@x", name: "A" }), { id: 1, email: "a@x", name: "A" });
});
