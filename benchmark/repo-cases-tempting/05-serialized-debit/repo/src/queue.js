// @ts-check

/**
 * Runs jobs strictly one at a time, in submission order (concurrency 1).
 * @returns {{ push: <T>(job: () => Promise<T>) => Promise<T> }}
 */
export function serialQueue() {
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  return {
    push(job) {
      const run = tail.then(job, job);
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
