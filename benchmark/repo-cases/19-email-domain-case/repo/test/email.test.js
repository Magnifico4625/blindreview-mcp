import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEmail } from "../src/email.js";

test("trims whitespace", () => assert.equal(normalizeEmail("  a@example.com "), "a@example.com"));

test("lowercases the domain only", () => assert.equal(normalizeEmail("John.Doe@Example.COM"), "John.Doe@example.com"));
test("uses the last @ (quoted local parts)", () => assert.equal(normalizeEmail('"a@b"@EXAMPLE.com'), '"a@b"@example.com'));
test("leaves strings without a domain alone", () => assert.equal(normalizeEmail(" nodomain "), "nodomain"));
