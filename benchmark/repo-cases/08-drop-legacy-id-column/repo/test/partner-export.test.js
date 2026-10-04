import { test } from "node:test";
import assert from "node:assert/strict";
import { partnerExport } from "../src/reports/partner-export.js";

test("passes partner as parameter", () => {
  let seen;
  partnerExport((sql, params) => { seen = params; return []; }, "acme");
  assert.deepEqual(seen, ["acme"]);
});
