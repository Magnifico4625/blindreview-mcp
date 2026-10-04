// @ts-check

/**
 * Deliberately loose: one "@" with something on both sides and no whitespace.
 * The address is proven by the confirmation email we send next; this check only catches typos
 * like a missing "@". Strict regexes rejected real customers (uppercase, IDN domains, "+tags",
 * new TLDs) - see the task context.
 * @param {string} email
 */
export function isPlausibleEmail(email) {
  const at = email.lastIndexOf("@");
  return at > 0 && at < email.length - 1 && !/\s/.test(email);
}
