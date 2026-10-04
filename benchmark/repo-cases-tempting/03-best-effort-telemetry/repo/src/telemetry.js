// @ts-check

/** @typedef {{ send: (event: object) => Promise<void> }} Transport */

/**
 * Telemetry is best-effort by product decision: a failed analytics send must never fail
 * or slow down the user's request. Failures are counted (exported as a metric) instead of thrown.
 * @param {Transport} transport
 */
export function createTelemetry(transport) {
  let dropped = 0;
  return {
    /** @param {object} event */
    async track(event) {
      try {
        await transport.send(event);
      } catch {
        dropped++;
      }
    },
    droppedEvents() {
      return dropped;
    },
  };
}
