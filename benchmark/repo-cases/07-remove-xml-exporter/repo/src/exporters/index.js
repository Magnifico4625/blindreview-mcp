// @ts-check
import { toCsv } from "./csv.js";
import { toJson } from "./json.js";

/** @typedef {(rows: Array<Record<string, string | number>>) => string} Exporter */

/** @type {Record<string, Exporter>} */
const EXPORTERS = { csv: toCsv, json: toJson };

/**
 * @param {string} format
 * @returns {Exporter}
 */
export function getExporter(format) {
  const exporter = EXPORTERS[format];
  if (!exporter) throw new Error(`unknown export format: ${format}`);
  return exporter;
}
