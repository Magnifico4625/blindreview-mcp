import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaults, main } from "../src/cli.js";

test("reads the config", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
  const f = path.join(dir, "c.json");
  writeFileSync(f, JSON.stringify({ outDir: "out", minify: true }));
  assert.equal(main([f]), "building into out (minified)");
});

test("defaults() is synchronous", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
  const f = path.join(dir, "c.json");
  writeFileSync(f, JSON.stringify({}));
  const d = defaults(f);
  assert.deepEqual(d, { outDir: "dist", minify: false });
});
