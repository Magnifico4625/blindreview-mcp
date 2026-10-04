import { test } from "node:test";
import assert from "node:assert/strict";
import { articlePath } from "../src/routes.js";

test("article path contains id and slug", () => {
  assert.equal(articlePath({ id: 7, title: "Release notes" }), "/articles/7-release-notes");
});
