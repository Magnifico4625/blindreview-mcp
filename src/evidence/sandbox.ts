import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findProjectRoot } from "../config.js";

/**
 * Read-only, size-capped tools over a small repository snapshot (evidence_gate, v0.4.0).
 *
 * Guarantees:
 *  - every path is resolved inside the snapshot root (no absolute paths, no "..", no symlink escape);
 *  - no tool writes to the snapshot: tests and the typecheck run in a throw-away temp copy;
 *  - no arbitrary commands: run_test only accepts a test file from the allowlist discovered at load
 *    time (test files present in the snapshot), typecheck runs the bundled tsc on the snapshot tsconfig;
 *  - child processes get a minimal environment (no API keys) and a hard timeout;
 *  - every tool output is truncated to a fixed size.
 * Each call returns text for the model plus mechanical ARTIFACTS (failing tests, typecheck errors,
 * search hits as file:line) that the harness later uses to validate "confirmed" claims.
 */

export type ArtifactType = "failing_test" | "typecheck_error" | "search_hit";
export interface Artifact {
  type: ArtifactType;
  /** Repo-relative file (search hit / typecheck error location, or the failing test file). */
  file: string;
  line?: number;
  detail: string;
}

export interface ToolOutput {
  ok: boolean;
  text: string;
  artifacts: Artifact[];
}

export interface SandboxLimits {
  maxOutputChars: number;
  maxReadLines: number;
  maxSearchHits: number;
  processTimeoutMs: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = { maxOutputChars: 4000, maxReadLines: 150, maxSearchHits: 25, processTimeoutMs: 30_000 };

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const CONFIG_FILE = /(^|\/)(package\.json|tsconfig[^/]*\.json)$|\.(json|sql|ya?ml|toml)$/i;
const TEST_FILE = /^test\/.+\.test\.(m?js|cjs)$/;

export class SandboxError extends Error {}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

export class RepoSandbox {
  readonly root: string;
  readonly limits: SandboxLimits;
  private files: string[] = [];
  private tempCopy: string | undefined;

  private constructor(root: string, limits: SandboxLimits) {
    this.root = root;
    this.limits = limits;
  }

  static async open(dir: string, limits: Partial<SandboxLimits> = {}): Promise<RepoSandbox> {
    const root = realpathSync(path.resolve(dir));
    const s = new RepoSandbox(root, { ...DEFAULT_SANDBOX_LIMITS, ...limits });
    s.files = await s.walk("");
    return s;
  }

  /** Repo-relative POSIX paths of all files (sorted). */
  listFiles(): string[] {
    return [...this.files];
  }

  /** Test files that run_test accepts. */
  testAllowlist(): string[] {
    return this.files.filter((f) => TEST_FILE.test(f));
  }

  private async walk(rel: string): Promise<string[]> {
    const out: string[] = [];
    const entries = await readdir(path.join(this.root, rel), { withFileTypes: true });
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...(await this.walk(r)));
      else if (e.isFile()) out.push(r);
    }
    return out.sort();
  }

  /** Resolve a model-supplied path strictly inside the snapshot. Throws SandboxError otherwise. */
  resolve(relPath: unknown): { abs: string; rel: string } {
    if (typeof relPath !== "string" || !relPath.trim()) throw new SandboxError("path must be a non-empty string");
    const cleaned = relPath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) throw new SandboxError("absolute paths are not allowed");
    const abs = path.resolve(this.root, cleaned);
    const rel = path.relative(this.root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new SandboxError("path escapes the repository snapshot");
    // Symlinks: resolve the nearest existing ancestor (or the path itself) and re-check containment.
    let probe = abs;
    while (!existsSync(probe) && probe !== this.root) probe = path.dirname(probe);
    const realRel = path.relative(this.root, realpathSync(probe));
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) throw new SandboxError("path escapes the repository snapshot");
    if (rel.split(path.sep).some((p) => SKIP_DIRS.has(p))) throw new SandboxError("path is not available");
    return { abs, rel: rel.split(path.sep).join("/") };
  }

  // ------------------------------------------------------------------ tools

  async readFile(args: { path?: unknown; start_line?: unknown }): Promise<ToolOutput> {
    const { abs, rel } = this.resolve(args.path);
    if (!this.files.includes(rel)) return { ok: false, text: `ERROR: no such file: ${rel}`, artifacts: [] };
    const st = await stat(abs);
    if (st.size > 200_000) return { ok: false, text: `ERROR: file too large (${st.size} bytes)`, artifacts: [] };
    const lines = (await readFile(abs, "utf8")).replace(/\r\n/g, "\n").split("\n");
    const start = Math.max(1, Math.floor(Number(args.start_line ?? 1)) || 1);
    const end = Math.min(lines.length, start + this.limits.maxReadLines - 1);
    const body = lines
      .slice(start - 1, end)
      .map((l, i) => `${String(start + i).padStart(4)}| ${l}`)
      .join("\n");
    const more = end < lines.length ? `\n...[${lines.length - end} more lines; call again with start_line=${end + 1}]` : "";
    return { ok: true, text: truncate(`${rel} (lines ${start}-${end} of ${lines.length})\n${body}${more}`, this.limits.maxOutputChars), artifacts: [] };
  }

  async search(args: { pattern?: unknown; path_prefix?: unknown; case_sensitive?: unknown }): Promise<ToolOutput> {
    if (typeof args.pattern !== "string" || !args.pattern || args.pattern.length > 200) {
      return { ok: false, text: "ERROR: pattern must be a non-empty string of at most 200 characters", artifacts: [] };
    }
    let re: RegExp;
    try {
      re = new RegExp(args.pattern, args.case_sensitive === true ? "" : "i");
    } catch (err) {
      return { ok: false, text: `ERROR: invalid regular expression: ${(err as Error).message}`, artifacts: [] };
    }
    const prefix = typeof args.path_prefix === "string" && args.path_prefix.trim() ? this.resolve(args.path_prefix).rel : "";
    return this.grep((line) => re.test(line), prefix, `search /${args.pattern}/`);
  }

  async findSymbol(args: { name?: unknown }): Promise<ToolOutput> {
    if (typeof args.name !== "string" || !/^[A-Za-z_$][\w$]{0,80}$/.test(args.name)) {
      return { ok: false, text: "ERROR: name must be a JavaScript identifier", artifacts: [] };
    }
    const name = args.name;
    const word = new RegExp(`(^|[^\\w$])${name.replace(/\$/g, "\\$")}($|[^\\w$])`);
    const def = new RegExp(
      `(function\\*?\\s+${name}\\b|class\\s+${name}\\b|(const|let|var)\\s+${name}\\b|@typedef\\s+\\{[\\s\\S]*\\}\\s+${name}\\b|(interface|type)\\s+${name}\\b|^\\s*${name}\\s*[:(])`,
    );
    const out = await this.grep((line) => word.test(line), "", `find_symbol ${name}`);
    const lines = out.text.split("\n");
    const tagged = lines.map((l, i) => (i === 0 ? l : def.test(l.replace(/^[^:]+:\d+: /, "")) ? `[definition] ${l}` : `[reference]  ${l}`));
    return { ...out, text: tagged.join("\n") };
  }

  private async grep(match: (line: string) => boolean, prefix: string, title: string): Promise<ToolOutput> {
    const hits: Artifact[] = [];
    let total = 0;
    for (const f of this.files) {
      if (prefix && f !== prefix && !f.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)) continue;
      const text = await readFile(path.join(this.root, f), "utf8");
      const lines = text.replace(/\r\n/g, "\n").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        if (!match(line)) continue;
        total++;
        if (hits.length < this.limits.maxSearchHits) hits.push({ type: "search_hit", file: f, line: i + 1, detail: line.trim().slice(0, 160) });
      }
    }
    const header = `${title}: ${total} hit(s)${total > hits.length ? ` (showing first ${hits.length})` : ""}`;
    const body = hits.map((h) => `${h.file}:${h.line}: ${h.detail}`).join("\n");
    return { ok: true, text: truncate(body ? `${header}\n${body}` : header, this.limits.maxOutputChars), artifacts: hits };
  }

  async inspectConfig(args: { path?: unknown }): Promise<ToolOutput> {
    if (args.path === undefined || args.path === null || args.path === "") {
      const configs = this.files.filter((f) => CONFIG_FILE.test(f));
      const pkg = this.files.includes("package.json") ? await readFile(path.join(this.root, "package.json"), "utf8") : "(no package.json)";
      const text = `package.json:\n${pkg}\nconfig/schema files: ${configs.join(", ") || "(none)"}\ntest allowlist (run_test): ${this.testAllowlist().join(", ") || "(none)"}`;
      return { ok: true, text: truncate(text, this.limits.maxOutputChars), artifacts: [] };
    }
    const { rel } = this.resolve(args.path);
    if (!CONFIG_FILE.test(rel)) return { ok: false, text: "ERROR: inspect_config only reads package/config/schema files (.json, .sql, .yaml, .toml); use read_file for source", artifacts: [] };
    return this.readFile({ path: rel });
  }

  async runTest(args: { test_file?: unknown }): Promise<ToolOutput> {
    const allow = this.testAllowlist();
    const rel = typeof args.test_file === "string" ? args.test_file.trim().replace(/^\.\//, "") : "";
    if (!allow.includes(rel)) return { ok: false, text: `ERROR: test_file must be one of the allowlist: ${allow.join(", ")}`, artifacts: [] };
    const cwd = await this.copy();
    const res = await runProcess(process.execPath, ["--test", rel], cwd, this.limits.processTimeoutMs);
    const out = res.output;
    const failingNames = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => (m[1] as string).trim());
    const pass = /^# pass (\d+)/m.exec(out)?.[1] ?? "?";
    const fail = /^# fail (\d+)/m.exec(out)?.[1] ?? "?";
    if (res.timedOut) return { ok: false, text: `run_test ${rel}: TIMEOUT after ${this.limits.processTimeoutMs} ms`, artifacts: [] };
    const failed = res.code !== 0 && failingNames.length > 0;
    const details = failed ? extractFailureDetails(out, this.limits.maxOutputChars - 300) : "";
    const text = `run_test ${rel}: exit ${res.code}, pass ${pass}, fail ${fail}${failingNames.length ? `\nfailing: ${failingNames.join(" | ")}` : ""}${details ? `\n${details}` : ""}`;
    const artifacts: Artifact[] = failed ? failingNames.map((n) => ({ type: "failing_test" as const, file: rel, detail: n })) : [];
    return { ok: true, text: truncate(text, this.limits.maxOutputChars), artifacts };
  }

  async typecheck(): Promise<ToolOutput> {
    if (!this.files.includes("tsconfig.json")) return { ok: false, text: "ERROR: no tsconfig.json in the snapshot", artifacts: [] };
    const tsc = path.join(findProjectRoot(), "node_modules", "typescript", "bin", "tsc");
    if (!existsSync(tsc)) return { ok: false, text: "ERROR: typescript is not installed in the harness", artifacts: [] };
    const cwd = await this.copy();
    const res = await runProcess(process.execPath, [tsc, "--noEmit", "-p", "tsconfig.json", "--pretty", "false"], cwd, this.limits.processTimeoutMs);
    if (res.timedOut) return { ok: false, text: `typecheck: TIMEOUT after ${this.limits.processTimeoutMs} ms`, artifacts: [] };
    const errors: Artifact[] = [];
    for (const m of res.output.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm)) {
      errors.push({ type: "typecheck_error", file: (m[1] as string).replace(/\\/g, "/"), line: Number(m[2]), detail: `${m[4]}: ${m[5]}` });
    }
    const text = res.code === 0 ? "typecheck: no errors" : `typecheck: exit ${res.code}, ${errors.length} error(s)\n${res.output.trim()}`;
    return { ok: true, text: truncate(text, this.limits.maxOutputChars), artifacts: errors };
  }

  /** Lazily create a throw-away copy of the snapshot for processes that might write files. */
  private async copy(): Promise<string> {
    if (!this.tempCopy) {
      this.tempCopy = await mkdtemp(path.join(os.tmpdir(), "br-evidence-"));
      await cp(this.root, this.tempCopy, { recursive: true, filter: (src) => !SKIP_DIRS.has(path.basename(src)) });
    }
    return this.tempCopy;
  }

  async dispose(): Promise<void> {
    if (this.tempCopy) await rm(this.tempCopy, { recursive: true, force: true });
    this.tempCopy = undefined;
  }
}

function extractFailureDetails(out: string, max: number): string {
  const blocks: string[] = [];
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*not ok \d+ - /.test(lines[i] as string) || /^\s{4,}/.test(lines[i] as string)) continue;
    const block = [lines[i] as string];
    for (let j = i + 1; j < lines.length && j < i + 30; j++) {
      const l = lines[j] as string;
      if (/^\s*(ok|not ok) \d+ - /.test(l) || /^# Subtest/.test(l)) break;
      if (/^\s*(duration_ms|async |TestContext|Test\.|node:internal)/.test(l.trim())) continue;
      block.push(l);
    }
    blocks.push(block.join("\n"));
  }
  return truncate(blocks.join("\n"), Math.max(500, max));
}

/** Minimal environment for child processes: never pass API keys or the caller's env through. */
export function childEnv(): NodeJS.ProcessEnv {
  return { PATH: path.dirname(process.execPath), NODE_ENV: "test", NO_COLOR: "1", HOME: os.tmpdir(), TMPDIR: os.tmpdir() };
}

function runProcess(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"], shell: false });
    let output = "";
    const add = (b: Buffer) => {
      if (output.length < 200_000) output += b.toString("utf8");
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: String(err), timedOut });
    });
  });
}
