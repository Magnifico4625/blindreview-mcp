// @ts-check
import { debounce } from "./debounce.js";

/**
 * Search box: query the backend at most once per typing pause.
 * @param {(q: string) => void} runQuery
 */
export function createSearchInput(runQuery) {
  return debounce(runQuery, 250);
}
