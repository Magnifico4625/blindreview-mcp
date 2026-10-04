// @ts-check

/**
 * Normalize an e-mail address for storage and uniqueness checks.
 * The domain is case-insensitive (RFC 5321 §2.4); the local part is preserved as typed.
 * @param {string} email
 */
export function normalizeEmail(email) {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed;
  return trimmed.slice(0, at) + "@" + trimmed.slice(at + 1).toLowerCase();
}
