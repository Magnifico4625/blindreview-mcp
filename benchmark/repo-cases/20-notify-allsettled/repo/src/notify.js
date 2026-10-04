// @ts-check

/**
 * @typedef {{ name: string, send(userId: string, message: string): Promise<void> }} Channel
 * @typedef {{ warn(msg: string, meta: Record<string, unknown>): void }} Logger
 */

/**
 * Send a notification on every channel. A failing channel no longer fails the whole job
 * (the job queue used to retry everything, re-sending on the channels that had succeeded).
 * Failures are logged and returned so the caller can record them.
 * @param {Channel[]} channels
 * @param {string} userId
 * @param {string} message
 * @param {Logger} logger
 * @returns {Promise<{ failed: string[] }>}
 */
export async function notifyAll(channels, userId, message, logger) {
  const results = await Promise.allSettled(channels.map((c) => c.send(userId, message)));
  /** @type {string[]} */
  const failed = [];
  results.forEach((r, i) => {
    const channel = channels[i];
    if (r.status === "rejected" && channel) {
      failed.push(channel.name);
      logger.warn("notification channel failed", { channel: channel.name, userId, error: String(r.reason) });
    }
  });
  return { failed };
}
