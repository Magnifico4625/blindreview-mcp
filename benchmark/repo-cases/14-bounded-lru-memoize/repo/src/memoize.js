// @ts-check

/**
 * Memoize a single-argument function with a bounded LRU cache.
 * Map preserves insertion order, so the first key is the least recently used one.
 * @template K, V
 * @param {(key: K) => V} fn
 * @param {number} [maxEntries]
 */
export function memoize(fn, maxEntries = 500) {
  /** @type {Map<K, V>} */
  const cache = new Map();
  /** @param {K} key */
  return (key) => {
    if (cache.has(key)) {
      const hit = /** @type {V} */ (cache.get(key));
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const value = fn(key);
    cache.set(key, value);
    if (cache.size > maxEntries) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    return value;
  };
}
