// @ts-check

/**
 * Deletes users one by one, on purpose. The identity provider's admin API allows exactly one
 * in-flight request per client and answers 429 + a 60 s lockout otherwise (see the task context).
 * The purge runs nightly on at most a few hundred ids, so throughput does not matter.
 * @param {{ deleteUser: (id: string) => Promise<void> }} api
 * @param {string[]} ids
 */
export async function purgeUsers(api, ids) {
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design (provider allows 1 in-flight request)
    await api.deleteUser(id);
  }
  return ids.length;
}
