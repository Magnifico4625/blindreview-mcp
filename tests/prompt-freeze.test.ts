import { describe, expect, it } from "vitest";
import { promptHashes } from "../src/reviewer/prompt-fingerprint.js";

/**
 * Frozen prompt hashes. proposal_first, proposal_first_2pass, blind_first and repair are frozen at
 * v0.2.0; independent_only and decision_judge at v0.3.0. If this test fails you changed a prompt:
 * revert it, or add a NEW named mode instead (benchmark comparability depends on it).
 */
const FROZEN: Record<string, string> = {
  proposal_first: "86399d1d74424d49",
  proposal_first_2pass: "babc3ad0bb43463c",
  blind_first: "d62bdbaf1e4a7d18",
  repair: "1cd5c9f17886635b",
  independent_only: "16d4fca86343b220",
  decision_judge: "60b581a50444a02e",
};

describe("prompt freeze", () => {
  it.each(Object.keys(FROZEN))("%s prompt template is unchanged", (mode) => {
    expect(promptHashes()[mode]).toBe(FROZEN[mode]);
  });

  it("no unpinned prompt templates", () => {
    expect(Object.keys(promptHashes()).sort()).toEqual(Object.keys(FROZEN).sort());
  });
});
