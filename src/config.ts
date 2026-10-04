import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  reasoningEffort: string | undefined;
  reasoningParam: "reasoning_effort" | "reasoning_object" | undefined;
  maxTokensPerCall: number;
  maxReviewTokens: number;
  maxToolCalls: number;
  timeoutMs: number;
  telemetryEnabled: boolean;
  telemetryPath: string;
}

export const DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5-mini",
  maxTokensPerCall: 4000,
  maxReviewTokens: 20000,
  maxToolCalls: 0,
  timeoutMs: 120_000,
  telemetryPath: path.join("data", "reviews.jsonl"),
} as const;

/** Walk up from this module to the directory containing our package.json (works from src/ and dist/src/). */
export function findProjectRoot(start: string = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (;;) {
    const pkg = path.join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string };
        if (parsed.name === "blindreview-mcp") return dir;
      } catch {
        // ignore unreadable package.json and keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

/**
 * Load .env without dependencies. Existing process.env values win (so values passed by the
 * MCP client config override the file). Looks at BLINDREVIEW_ENV_FILE, then <project root>/.env.
 * MCP clients often launch servers with an unrelated cwd (e.g. C:\Windows\System32), so cwd is not used.
 */
export function loadDotEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidate = env.BLINDREVIEW_ENV_FILE ?? path.join(findProjectRoot(), ".env");
  if (!existsSync(candidate)) return undefined;
  const parsed = parseDotEnv(readFileSync(candidate, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
  return candidate;
}

/** Minimal dotenv parser: KEY=VALUE, optional quotes, # comments, CRLF-safe. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] as string;
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

function intFrom(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 0): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`Invalid ${key}=${JSON.stringify(raw)}: expected an integer >= ${min}`);
  }
  return n;
}

function boolFrom(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const telemetryRaw = env.TELEMETRY_PATH?.trim() || DEFAULTS.telemetryPath;
  const telemetryPath = path.isAbsolute(telemetryRaw) ? telemetryRaw : path.join(findProjectRoot(), telemetryRaw);
  return {
    baseUrl: (env.REVIEWER_BASE_URL?.trim() || DEFAULTS.baseUrl).replace(/\/+$/, ""),
    apiKey: env.REVIEWER_API_KEY?.trim() || undefined,
    model: env.REVIEWER_MODEL?.trim() || DEFAULTS.model,
    reasoningEffort: env.REVIEWER_REASONING_EFFORT?.trim() || undefined,
    reasoningParam: reasoningParamFrom(env.REVIEWER_REASONING_PARAM),
    maxTokensPerCall: intFrom(env, "REVIEWER_MAX_TOKENS", DEFAULTS.maxTokensPerCall, 1),
    maxReviewTokens: intFrom(env, "MAX_REVIEW_TOKENS", DEFAULTS.maxReviewTokens, 1),
    maxToolCalls: intFrom(env, "MAX_TOOL_CALLS", DEFAULTS.maxToolCalls, 0),
    timeoutMs: intFrom(env, "REVIEW_TIMEOUT", DEFAULTS.timeoutMs, 1),
    telemetryEnabled: boolFrom(env, "TELEMETRY_ENABLED", false),
    telemetryPath,
  };
}

function reasoningParamFrom(raw: string | undefined): Config["reasoningParam"] {
  const v = raw?.trim();
  if (!v) return undefined;
  if (v === "reasoning_effort" || v === "reasoning_object") return v;
  throw new Error(`Invalid REVIEWER_REASONING_PARAM=${JSON.stringify(v)}: expected reasoning_effort or reasoning_object`);
}
