// @ts-check

/** @typedef {{ baseUrl: string, requestTimeoutMs: number, retries: number }} Config */

/**
 * @param {Record<string, string | undefined>} env
 * @returns {Config}
 */
export function loadConfig(env) {
  return {
    baseUrl: env.API_BASE_URL ?? "http://localhost:8080",
    requestTimeoutMs: Number(env.API_TIMEOUT_MS ?? 5000),
    retries: Number(env.API_RETRIES ?? 2),
  };
}
