// @ts-check

/**
 * @param {import("./config.js").Config} config
 * @param {string} path
 */
export function requestOptions(config, path) {
  return { url: `${config.baseUrl}${path}`, timeout: config.requestTimeoutMs, retries: config.retries };
}
