// @ts-check

/**
 * RFC 4180 field: quote when it contains a comma, double quote, CR or LF; double embedded quotes.
 * @param {string | number | null} value
 */
export function csvField(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param {string[]} header
 * @param {Array<Array<string | number | null>>} rows
 */
export function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n");
}
