/**
 * Minimal LRU cache built on the ES6 `Map` insertion-order guarantee
 * (ECMA-2015+ — `Map` iterates keys in insertion order; Node 22 complies fully).
 *
 * CONT-04c: bounds the rolling optimizer's `(epochId, scopeHash)` idempotency
 * memo at a fixed cap so it cannot grow without bound over an indefinite
 * (continuous-operation) run. No doubly-linked list is needed: `get` re-inserts
 * the accessed key (moving it to the MRU end), and `set` evicts the first
 * (least-recently-used) key once the cap is exceeded.
 *
 * Drop-in compatible with the `Map` subset the memo uses (`get`/`set`/`size`).
 */
export class LruMap<K, V> {
  private readonly cap: number;
  /** Insertion order == recency order (oldest first, MRU last). */
  private readonly map = new Map<K, V>();

  constructor(cap: number) {
    if (!Number.isInteger(cap) || cap <= 0) {
      throw new RangeError(`LruMap cap must be a positive integer, got ${cap}`);
    }
    this.cap = cap;
  }

  /**
   * Return the value for `k` (or `undefined`), promoting it to the MRU position
   * (delete + re-insert) so a recently-read entry survives eviction longest.
   */
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v); // re-insert at the MRU end
    }
    return v;
  }

  /**
   * Insert/update `k`→`v` at the MRU position, evicting the least-recently-used
   * entry (the first key in insertion order) once the cap is exceeded.
   */
  set(k: K, v: V): void {
    if (this.map.has(k)) this.map.delete(k); // avoid a stale insertion position
    this.map.set(k, v);
    if (this.map.size > this.cap) {
      const lru = this.map.keys().next().value;
      if (lru !== undefined) this.map.delete(lru);
    }
  }

  /** Current entry count (never exceeds the cap). */
  get size(): number {
    return this.map.size;
  }
}
