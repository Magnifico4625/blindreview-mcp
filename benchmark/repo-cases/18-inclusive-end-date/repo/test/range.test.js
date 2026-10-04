import { test } from "node:test";
import assert from "node:assert/strict";
import { eventsInRange } from "../src/range.js";

test("includes events at the start of the range", () => {
  const ev = [{ id: "a", at: "2026-03-01T00:00:00Z" }, { id: "b", at: "2026-02-28T23:59:59Z" }];
  assert.deepEqual(eventsInRange(ev, "2026-03-01", "2026-03-31").map((e) => e.id), ["a"]);
});

test("includes the whole last day and nothing after it", () => {
  const ev = [
    { id: "last", at: "2026-03-31T23:59:59.999Z" },
    { id: "next", at: "2026-04-01T00:00:00Z" },
  ];
  assert.deepEqual(eventsInRange(ev, "2026-03-01", "2026-03-31").map((e) => e.id), ["last"]);
});
