import { execFileSync } from "node:child_process";
import { findProjectRoot } from "../src/config.js";

export function gitInfo(): { sha: string | null; dirty: boolean | null } {
  const cwd = findProjectRoot();
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { sha, dirty: status.trim().length > 0 };
  } catch {
    return { sha: null, dirty: null };
  }
}
