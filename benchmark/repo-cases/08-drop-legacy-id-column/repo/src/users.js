// @ts-check

/**
 * Map a database row to the API user object.
 * @param {{ id: number, email: string, name: string }} row
 */
export function toApiUser(row) {
  return { id: row.id, email: row.email, name: row.name };
}

export const SELECT_USER = "SELECT id, email, name FROM users WHERE id = ?";
