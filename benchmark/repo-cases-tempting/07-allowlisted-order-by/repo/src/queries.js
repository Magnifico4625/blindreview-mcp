// @ts-check

/** Sortable columns. Keys are what the API accepts; values are fixed SQL identifiers. */
const SORT_COLUMNS = /** @type {const} */ ({ created: "created_at", total: "total", id: "id" });

/**
 * Identifiers cannot be bound as $n parameters in PostgreSQL, so the ORDER BY column and direction
 * are interpolated - but only from the fixed SORT_COLUMNS map and a two-value direction switch.
 * Unknown keys fall back to the default; user text never reaches the SQL string.
 * @param {{ status: string, sort?: string, dir?: string }} filter
 * @returns {{ text: string, values: unknown[] }}
 */
export function listInvoicesQuery(filter) {
  const key = /** @type {keyof typeof SORT_COLUMNS} */ (filter.sort ?? "created");
  const column = Object.hasOwn(SORT_COLUMNS, key) ? SORT_COLUMNS[key] : SORT_COLUMNS.created;
  const dir = filter.dir === "asc" ? "ASC" : "DESC";
  return { text: `SELECT id, total, created_at FROM invoices WHERE status = $1 ORDER BY ${column} ${dir}`, values: [filter.status] };
}
