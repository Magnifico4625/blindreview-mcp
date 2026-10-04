// @ts-check
import { readFileSync } from "node:fs";

/**
 * @typedef {{ outDir: string, minify: boolean }} BuildConfig
 */

/**
 * Read the build config once, synchronously, at process start.
 * This is a one-shot CLI: nothing else runs before the config is known, so blocking the event loop
 * here costs nothing, and a sync API lets the yargs-style `defaults()` callback stay synchronous.
 * @param {string} file @returns {BuildConfig}
 */
export function loadConfig(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return { outDir: String(raw.outDir ?? "dist"), minify: Boolean(raw.minify) };
}
