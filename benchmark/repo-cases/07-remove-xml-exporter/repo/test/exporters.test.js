import { test } from "node:test";
import assert from "node:assert/strict";
import { getExporter } from "../src/exporters/index.js";

const rows = [{ id: 1, name: "a" }];

test("csv", () => assert.equal(getExporter("csv")(rows), "id,name\n1,a"));
test("json", () => assert.equal(getExporter("json")(rows), '[{"id":1,"name":"a"}]'));
test("unknown format throws", () => assert.throws(() => getExporter("pdf")));
