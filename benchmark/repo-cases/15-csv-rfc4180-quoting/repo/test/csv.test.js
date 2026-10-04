import { test } from "node:test";
import assert from "node:assert/strict";
import { toCsv } from "../src/csv.js";

test("simple rows", () => {
  assert.equal(toCsv(["a", "b"], [[1, "x"], [2, null]]), "a,b\r\n1,x\r\n2,");
});

test("quotes commas, quotes and newlines", () => {
  assert.equal(toCsv(["note"], [["a,b"], ['say "hi"'], ["line1\nline2"]]), 'note\r\n"a,b"\r\n"say ""hi"""\r\n"line1\nline2"');
});
