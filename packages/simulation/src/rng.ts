/**
 * SIM-02 determinism primitive: a seeded, pure pseudo-random generator.
 *
 * The STACK guidance (research/STACK.md) is an explicit "custom LCG / seeded
 * RNG" with NO async-coroutine sim library — and to "seed everything"
 * (PITFALLS Pitfall 5). We use `mulberry32`: a tiny, fast, well-distributed
 * 32-bit generator whose entire state is one `uint32`. Given the same seed it
 * yields a byte-identical sequence on every platform (integer math only, no
 * `Math.random`, no `Date.now`), which is exactly what the byte-identical
 * event-stream test (threat T-01-15) requires.
 *
 * The seed is first run through a `splitmix32` mixing step so that small,
 * adjacent integer seeds (1, 2, 3 …) still produce well-separated streams —
 * otherwise nearby seeds start with visibly correlated output.
 */

/** A seeded random source. Deterministic for a fixed seed. */
export interface Rng {
  /** Next float in `[0, 1)`. */
  next: () => number;
  /** Next integer in `[0, maxExclusive)`. `maxExclusive` must be >= 1. */
  int: (maxExclusive: number) => number;
  /** Pick a uniformly-random element of a non-empty array. */
  pick: <T>(items: readonly T[]) => T;
  /**
   * Plan 19-08 (CONT-04): the RAW internal `uint32` state — a single serializable
   * number that fully captures the generator's position. Carried in the
   * `SimContinuation` so a resumed run draws the EXACT remaining sequence
   * (byte-identity keystone). Capturing/restoring `getState()` is a pure read; it
   * does NOT advance the generator.
   */
  getState: () => number;
}

const UINT32 = 0x1_0000_0000; // 2^32

/** splitmix32 finaliser — mixes a seed so adjacent seeds decorrelate. */
function mixSeed(seed: number): number {
  let z = (seed >>> 0) + 0x9e_37_79_b9;
  z = Math.imul(z ^ (z >>> 16), 0x21_f0_aa_ad);
  z = Math.imul(z ^ (z >>> 15), 0x73_5a_2d_97);
  return (z ^ (z >>> 15)) >>> 0;
}

/**
 * Construct a seeded RNG. The `next()` core is `mulberry32`; `int`/`pick` are
 * derived from it so ALL randomness flows through a single seeded source.
 */
export function makeRng(seed: number): Rng {
  return makeRngFromState(mixSeed(seed));
}

/**
 * Plan 19-08 (CONT-04): construct an RNG positioned at a previously-captured raw
 * `uint32` state (from {@link Rng.getState}). The returned generator produces the
 * EXACT sequence the original would have produced from that point — so a
 * `SimContinuation` can resume a sub-stream byte-identically. `makeRng(seed)` is
 * exactly `makeRngFromState(mixSeed(seed))`, so seeding is unchanged (the goldens
 * are byte-stable).
 */
export function makeRngFromState(rawState: number): Rng {
  // 32-bit integer state; arrow functions close over `state` (no `this`). The
  // state is normalized to a uint32 so a restored value behaves identically to a
  // freshly-mixed seed.
  let state = rawState >>> 0;

  const next = (): number => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };

  const int = (maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1) {
      throw new RangeError(`int(maxExclusive) needs an integer >= 1, got ${maxExclusive}`);
    }
    return Math.floor(next() * maxExclusive);
  };

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) {
      throw new RangeError("pick() requires a non-empty array");
    }
    return items[int(items.length)] as T;
  };

  // The raw state is read directly (a pure read — does NOT advance the stream).
  const getState = (): number => state;

  return { next, int, pick, getState };
}
