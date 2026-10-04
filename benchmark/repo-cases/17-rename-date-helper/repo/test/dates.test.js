import { test } from "node:test";
import assert from "node:assert/strict";
import { formatIsoDate } from "../src/dates.js";
import { invoiceDates } from "../src/invoices.js";

test("formats as UTC date", () => assert.equal(formatIsoDate(new Date("2026-03-05T23:30:00Z")), "2026-03-05"));
test("invoice dates", () => {
  assert.deepEqual(invoiceDates({ number: "1", issued: new Date("2026-01-01T00:00:00Z"), due: new Date("2026-01-31T00:00:00Z") }), { issued: "2026-01-01", due: "2026-01-31" });
});
