import path from "node:path";
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { estimateTokens } from "../src/providers/provider.js";
import { findProjectRoot, loadConfig, loadDotEnv, packageVersion, parseDotEnv } from "../src/config.js";

describe("config", () => {
  it("parses .env text with CRLF, quotes, comments and export", () => {
    const text = '# c\r\nA=1\r\nexport B="two words"\r\nC=\'x\' \r\nD=val # trailing\r\n\r\nBAD LINE\r\n';
    expect(parseDotEnv(text)).toEqual({ A: "1", B: "two words", C: "x", D: "val" });
  });

  it("applies defaults and resolves telemetry path against the project root", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ baseUrl: "https://api.openai.com/v1", telemetryEnabled: false, blindnessLeakThreshold: 0.5, temperature: undefined });
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

  it("validates REVIEWER_BASE_URL early with the variable name", () => {
    expect(() => loadConfig({ REVIEWER_BASE_URL: "api.openai.com/v1" })).toThrow(/REVIEWER_BASE_URL/);
    expect(() => loadConfig({ REVIEWER_BASE_URL: "ftp://x.example/v1" })).toThrow(/REVIEWER_BASE_URL/);
  });

  it("parses booleans strictly", () => {
    expect(loadConfig({ TELEMETRY_ENABLED: "off" }).telemetryEnabled).toBe(false);
    expect(loadConfig({ TELEMETRY_ENABLED: "Yes" }).telemetryEnabled).toBe(true);
    expect(() => loadConfig({ TELEMETRY_ENABLED: "ture" })).toThrow(/TELEMETRY_ENABLED/);
  });

  it("validates temperature and blindness thresholds", () => {
    expect(loadConfig({ REVIEWER_TEMPERATURE: "0.3" }).temperature).toBe(0.3);
    expect(() => loadConfig({ REVIEWER_TEMPERATURE: "hot" })).toThrow(/REVIEWER_TEMPERATURE/);
    expect(() => loadConfig({ BLINDNESS_LEAK_THRESHOLD: "2" })).toThrow(/BLINDNESS_LEAK_THRESHOLD/);
  });

  it("resolves a relative BLINDREVIEW_ENV_FILE against the project root, env wins over file", async () => {
    const root = findProjectRoot();
    const dir = await mkdtemp(path.join(root, ".tmp-env-"));
    try {
      await writeFile(path.join(dir, "test.env"), "REVIEWER_MODEL=from-file\r\nREVIEWER_API_KEY=file-key\r\n", "utf8");
      const env: NodeJS.ProcessEnv = { BLINDREVIEW_ENV_FILE: path.join(path.basename(dir), "test.env"), REVIEWER_API_KEY: "env-key" };
      expect(loadDotEnv(env)).toBe(path.join(dir, "test.env"));
      expect(env.REVIEWER_MODEL).toBe("from-file");
      expect(env.REVIEWER_API_KEY).toBe("env-key");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads the version from package.json", () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("token estimate is conservative and counts non-ASCII heavier", () => {
    expect(estimateTokens("a".repeat(300))).toBe(100);
    expect(estimateTokens("привет")).toBe(6);
  });
});
