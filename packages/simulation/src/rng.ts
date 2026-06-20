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
  // 32-bit integer state; arrow functions close over `state` (no `this`).
  let state = mixSeed(seed);

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

  return { next, int, pick };
}
