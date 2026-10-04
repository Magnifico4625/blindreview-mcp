// @ts-check
import { formatIsoDate } from "../dates.js";

/** @param {{ user: string, action: string, at: Date }} e */
export function auditLine(e) {
  return `${formatIsoDate(e.at)} ${e.user} ${e.action}`;
}
