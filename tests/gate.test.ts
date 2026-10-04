import { describe, expect, it } from "vitest";
import { evaluateGate } from "../src/gate/decision-gate.js";

describe("decision gate", () => {
  it.each([
    [{ decision_type: "architecture", risk_level: "medium" }, "architecture"],
    [{ decision_type: "implementation", risk_level: "medium", changes_db_schema: true }, "schema"],
    [{ decision_type: "implementation", risk_level: "low", includes_migration: true }, "migration"],
    [{ decision_type: "api", risk_level: "medium" }, "API"],
    [{ decision_type: "implementation", risk_level: "medium", changes_public_api: true }, "public API"],
    [{ decision_type: "dependency", risk_level: "medium", replaces_key_dependency: true }, "dependency"],
    [{ decision_type: "refactor", risk_level: "medium", files_changed: 20 }, "refactor"],
    [{ decision_type: "implementation", risk_level: "medium", modules_touched: 4 }, "multi-module"],
    [{ decision_type: "security", risk_level: "low" }, "security"],
    [{ decision_type: "performance", risk_level: "medium" }, "performance"],
    [{ decision_type: "debugging", risk_level: "medium", competing_hypotheses: 3 }, "hypotheses"],
    [{ decision_type: "implementation", risk_level: "critical" }, "critical"],
    [{ decision_type: "other", risk_level: "low", summary: "ALTER TABLE users DROP COLUMN legacy_id" }, "migration"],
  ] as const)("recommends review for %j", (input, reason) => {
    const r = evaluateGate(input);
    expect(r.should_review).toBe(true);
    expect(r.reasons.join(" ")).toContain(reason);
  });

  it.each([
    { decision_type: "implementation", risk_level: "low", trivial_kind: "formatting" },
    { decision_type: "refactor", risk_level: "low", trivial_kind: "rename", files_changed: 3 },
    { decision_type: "implementation", risk_level: "low", trivial_kind: "simple_ui" },
    { decision_type: "debugging", risk_level: "low", trivial_kind: "obvious_bugfix", competing_hypotheses: 1 },
    { decision_type: "other", risk_level: "low", trivial_kind: "docs" },
    { decision_type: "implementation", risk_level: "medium", files_changed: 2 },
    { decision_type: "performance", risk_level: "low" },
  ] as const)("does not recommend review for %j", (input) => {
    expect(evaluateGate(input).should_review).toBe(false);
  });

  it("structural signals override a trivial label (renaming a public API field)", () => {
    const r = evaluateGate({ decision_type: "refactor", risk_level: "low", trivial_kind: "rename", changes_public_api: true });
    expect(r.should_review).toBe(true);
  });

  it("is deterministic", () => {
    const input = { decision_type: "database", risk_level: "high", includes_migration: true } as const;
    expect(evaluateGate(input)).toEqual(evaluateGate(input));
  });
});
