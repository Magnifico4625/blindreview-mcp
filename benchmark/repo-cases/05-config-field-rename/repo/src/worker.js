// @ts-check

/**
 * Decide whether a running job has exceeded its deadline and must be cancelled.
 * @param {import("./config.js").Config} config
 * @param {{ startedAt: number }} job
 * @param {number} now
 */
export function isJobExpired(config, job, now) {
  const deadline = job.startedAt + config.timeoutMs * 4;
  return now > deadline;
}
