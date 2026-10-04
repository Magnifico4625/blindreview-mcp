// @ts-check
import { serialQueue } from "./queue.js";

/**
 * All balance mutations go through one serial queue, so the read-modify-write below never
 * interleaves with another mutation (this process is the only writer: see README "Ownership").
 * @param {ReturnType<typeof import("./store.js").createStore>} store
 */
export function createWallet(store) {
  const queue = serialQueue();
  return {
    /** @param {string} id @param {number} cents */
    credit(id, cents) {
      return queue.push(async () => {
        await store.set(id, (await store.get(id)) + cents);
      });
    },
    /**
     * Debit if the balance allows it. Returns false (no change) on insufficient funds.
     * @param {string} id @param {number} cents
     */
    debit(id, cents) {
      return queue.push(async () => {
        const balance = await store.get(id);
        if (balance < cents) return false;
        await store.set(id, balance - cents);
        return true;
      });
    },
  };
}
