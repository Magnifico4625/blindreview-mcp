// @ts-check

/** @param {Array<Record<string, string | number>>} rows */
export function toCsv(rows) {
  const first = rows[0];
  if (!first) return "";
  const cols = Object.keys(first);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => String(r[c] ?? "")).join(","))].join("\n");
}
