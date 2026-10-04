// @ts-check
import { loadConfig } from "./config.js";

/** Option defaults must be computed synchronously (the option parser calls this callback synchronously). */
/** @param {string} file */
export function defaults(file) {
  const config = loadConfig(file);
  return { outDir: config.outDir, minify: config.minify };
}

/** @param {string[]} argv */
export function main(argv) {
  const config = defaults(argv[0] ?? "build.config.json");
  return `building into ${config.outDir}${config.minify ? " (minified)" : ""}`;
}
