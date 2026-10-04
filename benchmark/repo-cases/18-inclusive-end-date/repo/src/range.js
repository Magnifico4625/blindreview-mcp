// @ts-check

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Events between `from` and `to` (both YYYY-MM-DD, UTC), inclusive of both days.
 * The end bound is exclusive at the start of the day after `to`.
 * @param {Array<{ id: string, at: string }>} events  ISO-8601 UTC timestamps
 * @param {string} from
 * @param {string} to
 */
export function eventsInRange(events, from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const endExclusive = Date.parse(`${to}T00:00:00Z`) + DAY_MS;
  return events.filter((e) => {
    const t = Date.parse(e.at);
    return t >= start && t < endExclusive;
  });
}
