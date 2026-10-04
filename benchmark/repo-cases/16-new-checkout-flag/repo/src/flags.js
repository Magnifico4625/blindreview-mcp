// @ts-check

/** @typedef {{ searchV2: boolean, newCheckout: boolean }} Flags */

/**
 * @param {Record<string, string | undefined>} env
 * @returns {Flags}
 */
export function loadFlags(env) {
  return {
    searchV2: parseBool(env.FLAG_SEARCH_V2, false),
    newCheckout: parseBool(env.FLAG_NEW_CHECKOUT, false),
  };
}

/**
 * @param {string | undefined} raw
 * @param {boolean} fallback
 */
export function parseBool(raw, fallback) {
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}
