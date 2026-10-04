// @ts-check
import { formatIsoDate } from "./dates.js";

/** @param {{ number: string, issued: Date, due: Date }} i */
export function invoiceDates(i) {
  return { issued: formatIsoDate(i.issued), due: formatIsoDate(i.due) };
}
