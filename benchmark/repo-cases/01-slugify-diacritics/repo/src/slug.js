// @ts-check

/**
 * Turn an article title into a URL slug. Slugs are part of public, already-shared article URLs.
 * @param {string} title
 * @returns {string}
 */
export function slugify(title) {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}
