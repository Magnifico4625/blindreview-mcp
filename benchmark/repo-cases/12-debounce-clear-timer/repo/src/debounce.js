// @ts-check

/**
 * Debounce: call fn once, `waitMs` after the last call.
 * @template {unknown[]} A
 * @param {(...args: A) => void} fn
 * @param {number} waitMs
 * @param {{ setTimer?: (cb: () => void, ms: number) => unknown, clearTimer?: (handle: unknown) => void }} [timers]
 */
export function debounce(fn, waitMs, timers = {}) {
  const setTimer = timers.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = timers.clearTimer ?? ((h) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (h)));
  /** @type {unknown} */
  let pending;
  /** @param {A} args */
  return (...args) => {
    if (pending !== undefined) clearTimer(pending);
    pending = setTimer(() => {
      pending = undefined;
      fn(...args);
    }, waitMs);
  };
}
