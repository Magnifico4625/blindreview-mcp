// @ts-check
import { formatIsoDate } from "./dates.js";

/** @param {{ title: string, at: Date }} r */
export function reportHeader(r) {
  return `${r.title} — ${formatIsoDate(r.at)}`;
}
