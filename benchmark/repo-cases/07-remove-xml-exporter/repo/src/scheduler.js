// @ts-check
import { getExporter } from "./exporters/index.js";

/**
 * Runs scheduled reports. Schedules are loaded from config/report-schedules.json at startup.
 * @param {{ name: string, format: string }} schedule
 * @param {Array<Record<string, string | number>>} rows
 */
export function runSchedule(schedule, rows) {
  return { name: schedule.name, body: getExporter(schedule.format)(rows) };
}
