import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Reviewer } from "../src/reviewer/reviewer.js";
import { Telemetry } from "../src/telemetry/telemetry.js";
import { FakeProvider, SENTINEL, makeInput, testConfig, validPosition, validVerdict } from "./helpers.js";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), "blindreview-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("telemetry", () => {
  it("stores metadata only: no context, objective, constraints, proposal or reviewer text", async () => {
    const file = path.join(await tmp(), "nested", "reviews.jsonl");
    const telemetry = new Telemetry(true, file);
    const reviewer = new Reviewer({ ...testConfig, provider: FakeProvider.sequence(validPosition, validVerdict), telemetry });
    const input = makeInput({ objective: "OBJ-SECRET-1", context: "CTX-SECRET-2", constraints: ["CON-SECRET-3"], evidence: ["EVD-SECRET-4"], environment: "ENV-SECRET-5" });
    const result = await reviewer.review(input);
    const text = await readFile(file, "utf8");
    for (const s of [SENTINEL, "OBJ-SECRET-1", "CTX-SECRET-2", "CON-SECRET-3", "EVD-SECRET-4", "ENV-SECRET-5", validVerdict.recommendation, validPosition.preferred_solution]) {
      expect(text).not.toContain(s);
    }
    const record = JSON.parse(text.trim()) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(
      ["confidence", "decision_type", "id", "latency_ms", "review_mode", "reviewer_model", "risk_level", "status", "timestamp", "type", "usage", "verdict"].sort(),
    );
    expect(record).toMatchObject({ type: "review", id: result.meta.review_id, verdict: "MODIFY", status: "ok" });
  });

  it("records errors and outcomes", async () => {
    const file = path.join(await tmp(), "r.jsonl");
    const telemetry = new Telemetry(true, file);
    const reviewer = new Reviewer({ ...testConfig, provider: FakeProvider.sequence("x", "y"), telemetry });
    await expect(reviewer.review(makeInput())).rejects.toThrow();
    await telemetry.recordOutcome({ review_id: "abc", accepted_review: true, later_rework_required: false, review_was_useful: true });
    const rows = await telemetry.readAll();
    expect(rows[0]).toMatchObject({ type: "review", status: "error", error_code: "MALFORMED_RESPONSE" });
    expect(rows[1]).toMatchObject({ type: "outcome", review_id: "abc", accepted_review: true, later_rework_required: false, review_was_useful: true });
  });

  it("writes nothing when disabled (default)", async () => {
    const file = path.join(await tmp(), "off.jsonl");
    const telemetry = new Telemetry(false, file);
    const reviewer = new Reviewer({ ...testConfig, provider: FakeProvider.sequence(validPosition, validVerdict), telemetry });
    await reviewer.review(makeInput());
    expect(await telemetry.recordOutcome({ review_id: "x", accepted_review: true })).toBe(false);
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });
});
