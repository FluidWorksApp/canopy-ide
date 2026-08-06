/** Insert as the newest entry and evict least-recently-written entries.
 *
 * Module-level UI caches outlive every component that uses them, so they need
 * an explicit ceiling even when each value is small. Reading does not refresh
 * recency: these caches optimize tab switches, and fresh poll results are the
 * useful signal for what should remain warm.
 */
export function setBounded<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number,
) {
  if (maxEntries < 1) return;
  map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}
