import path from "node:path";
import { describe, expect, it } from "vitest";
import { findProjectRoot, loadConfig, parseDotEnv } from "../src/config.js";

describe("config", () => {
  it("parses .env text with CRLF, quotes, comments and export", () => {
    const text = '# c\r\nA=1\r\nexport B="two words"\r\nC=\'x\' \r\nD=val # trailing\r\n\r\nBAD LINE\r\n';
    expect(parseDotEnv(text)).toEqual({ A: "1", B: "two words", C: "x", D: "val" });
  });

  it("applies defaults and resolves telemetry path against the project root", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ baseUrl: "https://api.openai.com/v1", maxToolCalls: 0, telemetryEnabled: false });
    expect(c.telemetryPath).toBe(path.join(findProjectRoot(), "data", "reviews.jsonl"));
  });

  it("reads env values and validates numbers", () => {
    const c = loadConfig({
      REVIEWER_BASE_URL: "http://localhost:11434/v1/",
      REVIEWER_MODEL: "qwen3:8b",
      MAX_REVIEW_TOKENS: "5000",
      TELEMETRY_ENABLED: "true",
      REVIEWER_REASONING_PARAM: "reasoning_object",
    });
    expect(c).toMatchObject({ baseUrl: "http://localhost:11434/v1", model: "qwen3:8b", maxReviewTokens: 5000, telemetryEnabled: true, reasoningParam: "reasoning_object" });
    expect(() => loadConfig({ MAX_REVIEW_TOKENS: "lots" })).toThrow(/MAX_REVIEW_TOKENS/);
    expect(() => loadConfig({ REVIEWER_REASONING_PARAM: "x" })).toThrow(/REVIEWER_REASONING_PARAM/);
  });
});
