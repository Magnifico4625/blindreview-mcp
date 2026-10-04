// @ts-check

/**
 * Nightly export for partner reconciliation. The partner matches our users by their old ids.
 */
export const PARTNER_EXPORT_SQL = `
  SELECT id, email, legacy_id
  FROM users
  WHERE partner = ?
  ORDER BY id
`;

/**
 * @param {(sql: string, params: unknown[]) => Array<Record<string, unknown>>} query
 * @param {string} partner
 */
export function partnerExport(query, partner) {
  return query(PARTNER_EXPORT_SQL, [partner]);
}
