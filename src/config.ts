import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  reasoningEffort: string | undefined;
  reasoningParam: "reasoning_effort" | "reasoning_object" | undefined;
  /** Optional sampling temperature; not sent when undefined. */
  temperature: number | undefined;
  maxTokensPerCall: number;
  maxReviewTokens: number;
  timeoutMs: number;
  /** Containment of proposal word 5-grams in the blind fields above which blind_first refuses. */
  blindnessLeakThreshold: number;
  /** Above this, a blindness_warning is attached to meta. */
  blindnessWarnThreshold: number;
  telemetryEnabled: boolean;
  telemetryPath: string;
}

export const DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5-mini",
  maxTokensPerCall: 4000,
  maxReviewTokens: 20000,
  timeoutMs: 120_000,
  blindnessLeakThreshold: 0.5,
  blindnessWarnThreshold: 0.15,
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

/** Version from our package.json (single source of truth). */
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(findProjectRoot(), "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Load .env without dependencies. Existing process.env values win (so values passed by the
 * MCP client config override the file). Uses BLINDREVIEW_ENV_FILE (relative paths resolve
 * against the project root) or <project root>/.env. MCP clients often launch servers with an
 * unrelated cwd (e.g. C:\Windows\System32), so cwd is never used.
 */
export function loadDotEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = findProjectRoot();
  const configured = env.BLINDREVIEW_ENV_FILE?.trim();
  const candidate = configured ? (path.isAbsolute(configured) ? configured : path.join(root, configured)) : path.join(root, ".env");
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

function numberFrom(env: NodeJS.ProcessEnv, key: string, min: number, max: number): number | undefined {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`Invalid ${key}=${JSON.stringify(raw)}: expected a number in [${min}, ${max}]`);
  }
  return n;
}

const TRUE = ["1", "true", "yes", "on"];
const FALSE = ["0", "false", "no", "off"];

function boolFrom(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (TRUE.includes(raw)) return true;
  if (FALSE.includes(raw)) return false;
  throw new Error(`Invalid ${key}=${JSON.stringify(env[key])}: expected true/false (also 1/0, yes/no, on/off)`);
}

function baseUrlFrom(env: NodeJS.ProcessEnv): string {
  const raw = env.REVIEWER_BASE_URL?.trim() || DEFAULTS.baseUrl;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid REVIEWER_BASE_URL=${JSON.stringify(raw)}: expected an absolute http(s) URL such as https://api.openai.com/v1`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid REVIEWER_BASE_URL=${JSON.stringify(raw)}: protocol must be http or https`);
  }
  return raw.replace(/\/+$/, "");
}

function reasoningParamFrom(raw: string | undefined): Config["reasoningParam"] {
  const v = raw?.trim();
  if (!v) return undefined;
  if (v === "reasoning_effort" || v === "reasoning_object") return v;
  throw new Error(`Invalid REVIEWER_REASONING_PARAM=${JSON.stringify(v)}: expected reasoning_effort or reasoning_object`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const telemetryRaw = env.TELEMETRY_PATH?.trim() || DEFAULTS.telemetryPath;
  const telemetryPath = path.isAbsolute(telemetryRaw) ? telemetryRaw : path.join(findProjectRoot(), telemetryRaw);
  const leak = numberFrom(env, "BLINDNESS_LEAK_THRESHOLD", 0, 1) ?? DEFAULTS.blindnessLeakThreshold;
  const warn = Math.min(numberFrom(env, "BLINDNESS_WARN_THRESHOLD", 0, 1) ?? DEFAULTS.blindnessWarnThreshold, leak);
  return {
    baseUrl: baseUrlFrom(env),
    apiKey: env.REVIEWER_API_KEY?.trim() || undefined,
    model: env.REVIEWER_MODEL?.trim() || DEFAULTS.model,
    reasoningEffort: env.REVIEWER_REASONING_EFFORT?.trim() || undefined,
    reasoningParam: reasoningParamFrom(env.REVIEWER_REASONING_PARAM),
    temperature: numberFrom(env, "REVIEWER_TEMPERATURE", 0, 2),
    maxTokensPerCall: intFrom(env, "REVIEWER_MAX_TOKENS", DEFAULTS.maxTokensPerCall, 1),
    maxReviewTokens: intFrom(env, "MAX_REVIEW_TOKENS", DEFAULTS.maxReviewTokens, 1),
    timeoutMs: intFrom(env, "REVIEW_TIMEOUT", DEFAULTS.timeoutMs, 1),
    blindnessLeakThreshold: leak,
    blindnessWarnThreshold: warn,
    telemetryEnabled: boolFrom(env, "TELEMETRY_ENABLED", false),
    telemetryPath,
  };
}
