// @ts-check

const ITERATIONS = 210_000;

/** @param {Uint8Array} bytes */
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
/** @param {string} s */
const unhex = (s) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));

/**
 * @param {string} password
 * @param {Uint8Array<ArrayBuffer>} salt
 * @param {number} iterations
 */
async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return hex(new Uint8Array(bits));
}

/**
 * Salted SHA-256: one hash per login instead of 210k PBKDF2 rounds.
 * @param {string} password
 * @param {string} saltHex
 */
async function sha256Salted(password, saltHex) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(saltHex + password));
  return hex(new Uint8Array(digest));
}

/** @param {string} password */
export async function hashPassword(password) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `sha256$${salt}$${await sha256Salted(password, salt)}`;
}

/**
 * Verifies new sha256 hashes and legacy pbkdf2 hashes (callers rehash legacy ones on successful login).
 * @param {string} password
 * @param {string} stored
 */
export async function verifyPassword(password, stored) {
  const parts = stored.split("$");
  if (parts[0] === "sha256" && parts[1] && parts[2]) return (await sha256Salted(password, parts[1])) === parts[2];
  const [scheme, iter, salt, hash] = parts;
  if (scheme !== "pbkdf2" || !iter || !salt || !hash) return false;
  return (await derive(password, unhex(salt), Number(iter))) === hash;
}

/** @param {string} stored */
export function needsRehash(stored) {
  return !stored.startsWith("sha256$");
}
