import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runToHorizon, simulate, type SimulatedEvent } from "../src/engine.js";
import type { SimContinuation } from "../src/continuation.js";

/**
 * ADVERSARIAL determinism + bounded-retention verifier (Plan 19-08, p19-fix).
 *
 * Goal: TRY HARD TO BREAK the chunked/continuation path's byte-identity with the
 * all-at-once `simulate()` path, and to expose any phantom/closure/pointer state
 * leaking through the serializable `SimContinuation`. Every assertion is a
 * SHA-256 over an ORDERED, POINTER-FREE serialization of the stream — so a hash
 * match is byte-identity of DOMAIN DATA, never object identity.
 *
 * These complement (do not duplicate) `continuation-equivalence.unit.test.ts`:
 *   - we add chunk sizes 2 & 3 (the existing file does 1, 7, 500),
 *   - boundaries that land EXACTLY on an event-firing tick,
 *   - interleaved/repeated all-at-once vs chunked IN ONE PROCESS,
 *   - a DEEP-FROZEN + structurally-cloned continuation resume (pointer-identity trap),
 *   - resume-from-tick-0, empty chunk, and horizon-beyond-all-activity edges,
 *   - ALL feature flags on AT ONCE so every seeded sub-stream is forced to draw.
 */

// --- stable, pointer-free serialization -------------------------------------

/** Stable, pointer-free serialization of one event (domain ids + payload only). */
function serializeEvent(e: SimulatedEvent): string {
  return `${e.streamId}${e.occurredAt}${JSON.stringify(e.event)}`;
}

/** SHA-256 over the ordered stream (no object identity anywhere). */
function hashStream(stream: readonly SimulatedEvent[]): string {
  const h = createHash("sha256");
  for (const e of stream) {
    h.update(serializeEvent(e));
    h.update(""); // record separator
  }
  return h.digest("hex");
}

type FeatureOpts = Omit<Parameters<typeof simulate>[0], "seed" | "durationTicks">;

/**
 * A short transit config so round-trips COMPLETE inside a modest horizon — this
 * forces trailers to arrive, re-dispatch, over-carry, rest, refuel, and emit
 * mid-leg stops, i.e. it exercises EVERY task variant and EVERY sub-stream.
 */
const SHORT_TIMING = {
  transit: { median: 6, sigma: 0.05, min: 1, max: 60 },
  dwellSpoke: { median: 3, sigma: 0.05, min: 1, max: 30 },
  dwellCenter: { median: 4, sigma: 0.05, min: 1, max: 30 },
} as const;

/**
 * ALL feature flags ON — rfid + over-carry + HOS + fuel + induction. This is the
 * maximal state surface: every one of the SEVEN seeded sub-streams (base, rfid,
 * overCarry, timing, hos, fuel, induction) is forced to draw, and every SimTask
 * variant (createPackageBatch, inductPackage, departTrailer, arriveTrailer,
 * midLegStops, arriveOverCarriedAtCenter) fires. A missed sub-stream OR a missed
 * pending task in the continuation diverges here. Adding `inductionEnabled: true`
 * costs ZERO additional test cases — it rides the existing chunk-1 matrix.
 */
const ALL_ON: FeatureOpts = {
  timing: SHORT_TIMING,
  rfid: {},
  overCarry: 0.5,
  hosEnabled: true,
  fuel: {
    enabled: true,
    milesPerGallon: 6,
    tankCapacityGallons: 200,
    refuelThresholdMiles: 120,
    refuelTimeMinutes: 30,
  },
  // v2.0 IND-02: include external induction in the maximal state surface so the
  // SEVENTH sub-stream (induction RNG) + the inductPackage SimTask variant are
  // exercised under the most adversarial chunk-1 / clone+freeze boundaries.
  inductionEnabled: true,
};

/**
 * Drive [0, horizonTick] entirely through the continuation API in fixed
 * `chunkSize`-tick steps, collecting the ordered stream. The prefix is NEVER
 * regenerated (the continuation carries it), so this is the real chunked path.
 */
function chunkedStream(
  seed: number,
  horizonTick: number,
  chunkSize: number,
  opts: FeatureOpts = {},
): SimulatedEvent[] {
  const collected: SimulatedEvent[] = [];
  let continuation: SimContinuation | undefined;
  for (let target = chunkSize; ; target += chunkSize) {
    const horizon = Math.min(target, horizonTick);
    const start = continuation ?? { seed };
    const { events, continuation: next } = runToHorizon(start, horizon, opts);
    collected.push(...events);
    continuation = next;
    if (horizon >= horizonTick) break;
  }
  return collected;
}

/**
 * Drive [0, horizonTick] through the continuation, ROUND-TRIPPING the
 * continuation through `structuredClone` (a deep, pointer-free copy) at EVERY
 * boundary and DEEP-FREEZING it before resume. If any resume path mutates
 * captured state in place, or relies on object identity / a live closure rather
 * than the serialized data, the freeze throws or the clone diverges.
 */
function clonedFrozenChunkedStream(
  seed: number,
  horizonTick: number,
  chunkSize: number,
  opts: FeatureOpts = {},
): SimulatedEvent[] {
  const collected: SimulatedEvent[] = [];
  let continuation: SimContinuation | undefined;
  for (let target = chunkSize; ; target += chunkSize) {
    const horizon = Math.min(target, horizonTick);
    const start: SimContinuation | { seed: number } =
      continuation === undefined ? { seed } : deepFreeze(structuredClone(continuation));
    const { events, continuation: next } = runToHorizon(start, horizon, opts);
    collected.push(...events);
    continuation = next;
    if (horizon >= horizonTick) break;
  }
  return collected;
}

/** Recursively Object.freeze a value (arrays + nested objects), returning it. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 1. RNG-state completeness across EVERY sub-stream
// ---------------------------------------------------------------------------

describe("adversarial: RNG-state completeness across every sub-stream", () => {
  // The sub-stream-completeness property (no dropped seeded draw across a chunk
  // boundary) is SEED-INDEPENDENT and CHUNK-SIZE-independent once it holds for
  // the worst case (chunk-1). We keep a tiny seed set and prove the worst-case
  // chunk-1 on one seed; the other seeds use a coarser chunk-3 to keep coverage
  // breadth without paying O(horizon) chunk-1 cost per seed (p19-fix Step 1).
  const SEEDS = [1, 42, 1234] as const;
  const HORIZON = 700;

  for (const seed of SEEDS) {
    // Worst-case chunk-1 (capture/restore at almost every tick) on the lead seed
    // only; the property is seed-independent so the rest use coarse chunk-3.
    const chunk = seed === SEEDS[0] ? 1 : 3;
    it(`ALL features on: chunked(${chunk}) byte-identical to all-at-once (seed ${seed}, h ${HORIZON})`, () => {
      const allAtOnce = simulate({ seed, durationTicks: HORIZON, ...ALL_ON });
      const chunked = chunkedStream(seed, HORIZON, chunk, ALL_ON);
      expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
      expect(chunked.length).toBe(allAtOnce.length);
    });
  }

  // The base (operational) RNG draws (package count/dest/size/weight) at fixed
  // 15-tick batch ticks; the timing RNG draws at every depart/arrive; HOS jitter
  // at every inserted rest; over-carry at every spoke arrival. A chunk boundary
  // landing EXACTLY on a batch tick (15, 30, 45 …) or a departure tick is the
  // highest-risk place to drop a draw — assert several such alignments.
  for (const boundary of [15, 16, 30, 45, 60] as const) {
    it(`boundary chunk=${boundary} aligned to event ticks stays byte-identical (all-on, seed 1234, h 600)`, () => {
      const allAtOnce = simulate({ seed: 1234, durationTicks: 600, ...ALL_ON });
      const chunked = chunkedStream(1234, 600, boundary, ALL_ON);
      expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
      expect(chunked.length).toBe(allAtOnce.length);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Phantom module / closure / cache state
// ---------------------------------------------------------------------------

describe("adversarial: no phantom module/closure/cache state", () => {
  it("interleaved all-at-once -> chunked -> all-at-once in ONE process are all identical", () => {
    const seed = 1234;
    const h = 800;
    const before = simulate({ seed, durationTicks: h, ...ALL_ON });
    const chunked = chunkedStream(seed, h, 3, ALL_ON);
    const after = simulate({ seed, durationTicks: h, ...ALL_ON });
    const hBefore = hashStream(before);
    expect(hashStream(chunked)).toBe(hBefore);
    expect(hashStream(after)).toBe(hBefore); // no module-global leaked between runs
  });

  it("repeated chunked runs with DIFFERENT chunk sizes interleaved are all identical", () => {
    const seed = 7;
    const h = 600;
    const gold = hashStream(simulate({ seed, durationTicks: h, ...ALL_ON }));
    // Interleave chunk sizes to provoke any cross-run cache. We keep ONE chunk-1
    // (the worst-case fine boundary) and bracket it with coarser sizes; repeating
    // chunk-1 three times added only O(h) cost without new coverage, so the
    // interleave is now 1, 5, 13, 5 (still alternates fine/coarse across runs).
    for (const c of [1, 5, 13, 5] as const) {
      expect(hashStream(chunkedStream(seed, h, c, ALL_ON))).toBe(gold);
    }
  });

  it("JSON round-trip of the continuation mid-run resumes byte-identically", () => {
    const seed = 1234;
    const opts = ALL_ON;
    // Capture a mid-run continuation, JSON round-trip it, and resume BOTH copies
    // to a far horizon — the streams must be byte-identical.
    const { continuation } = runToHorizon({ seed }, 250, opts);
    const revived = JSON.parse(JSON.stringify(continuation)) as SimContinuation;
    const fromMem = runToHorizon(continuation, 900, opts);
    const fromJson = runToHorizon(revived, 900, opts);
    expect(hashStream(fromJson.events)).toBe(hashStream(fromMem.events));
    // And the resulting continuations are themselves JSON-equal (no hidden state).
    expect(JSON.stringify(fromJson.continuation)).toBe(JSON.stringify(fromMem.continuation));
  });

  it("a continuation contains ONLY JSON-serializable data (no functions / symbols)", () => {
    const { continuation } = runToHorizon({ seed: 1234 }, 300, ALL_ON);
    // Round-trip equality proves there is no non-JSON state; also walk it for
    // any function/symbol/undefined-in-array that JSON would silently drop.
    const round: unknown = JSON.parse(JSON.stringify(continuation));
    expect(round).toEqual(JSON.parse(JSON.stringify(continuation)) as unknown);
    const walk = (v: unknown): void => {
      expect(typeof v).not.toBe("function");
      expect(typeof v).not.toBe("symbol");
      if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(continuation);
  });
});

// ---------------------------------------------------------------------------
// 3. Pointer / object-identity trap
// ---------------------------------------------------------------------------

describe("adversarial: no pointer/object-identity dependence", () => {
  // clonedFrozenChunkedStream does a structuredClone + deep-freeze at EVERY
  // boundary, so the per-test cost is O(horizon / chunk) deep clones. The
  // pointer-identity trap is independent of chunk size once chunk-1 (a clone at
  // every tick) passes, so we prove the worst-case chunk-1 at a SHORT horizon
  // and the larger horizon under a coarse chunk-7 (far fewer clones) — p19-fix.
  const IDENTITY_CASES = [
    { chunk: 1, h: 300 }, // worst case: clone+freeze at almost every tick
    { chunk: 2, h: 300 },
    { chunk: 3, h: 400 },
    { chunk: 7, h: 700 }, // full horizon, coarse chunk → ~100 clones
  ] as const;
  for (const { chunk, h } of IDENTITY_CASES) {
    it(`deep-frozen + structuredClone'd continuation at every boundary stays byte-identical (chunk ${chunk}, h ${h})`, () => {
      const seed = 1234;
      const allAtOnce = simulate({ seed, durationTicks: h, ...ALL_ON });
      // If ANY map is keyed by object identity (not a stable string), or any
      // resume mutates captured state in place, the frozen clone diverges/throws.
      const cloned = clonedFrozenChunkedStream(seed, h, chunk, ALL_ON);
      expect(hashStream(cloned)).toBe(hashStream(allAtOnce));
      expect(cloned.length).toBe(allAtOnce.length);
    });
  }

  it("freezing the continuation does NOT block resume (engine reads, never mutates, captured state)", () => {
    const { continuation } = runToHorizon({ seed: 42 }, 200, ALL_ON);
    const frozen = deepFreeze(structuredClone(continuation));
    // Must not throw a 'cannot assign to read only property' — the engine copies
    // captured arrays/maps into fresh mutable structures before mutating.
    expect(() => runToHorizon(frozen, 400, ALL_ON)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Chunk-boundary edge cases
// ---------------------------------------------------------------------------

describe("adversarial: chunk-boundary edge cases", () => {
  it("chunkSize=1 over a horizon stays byte-identical (all-on, seed 1234, h 800)", () => {
    // chunk-1 byte-identity over a multi-batch horizon. Capped at h 800 (≤ the
    // p19-fix chunk-1 ceiling); long-horizon chunk-crossing is separately proven
    // by the HOS regression (chunk-2 h 2000) and the coarse-chunk equivalence.
    const allAtOnce = simulate({ seed: 1234, durationTicks: 800, ...ALL_ON });
    const chunked = chunkedStream(1234, 800, 1, ALL_ON);
    expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
    expect(chunked.length).toBe(allAtOnce.length);
  });

  it("resume from a fresh chunk that drained to tick 0 (horizon 0 then extend)", () => {
    const seed = 1234;
    const opts = ALL_ON;
    // First chunk to horizon 0: fires only the tick-0 bootstrap + tick-0 batch.
    const first = runToHorizon({ seed }, 0, opts);
    // The tick-1 departures are still queued; resume to a real horizon.
    const rest = runToHorizon(first.continuation, 600, opts);
    const chunkedH0 = [...first.events, ...rest.events];
    const allAtOnce = simulate({ seed, durationTicks: 600, ...opts });
    expect(hashStream(chunkedH0)).toBe(hashStream(allAtOnce));
    expect(chunkedH0.length).toBe(allAtOnce.length);
  });

  it("an EMPTY chunk (no events in the window) does not perturb the stream", () => {
    const seed = 1234;
    const opts = ALL_ON;
    // Drive to a horizon, then take a chunk that advances the horizon by 0 — the
    // queue head is strictly beyond the previous horizon, so NO task fires and the
    // empty chunk must leave the continuation functionally unchanged.
    const a = runToHorizon({ seed }, 300, opts);
    const emptyA = runToHorizon(a.continuation, 300, opts); // horizon unchanged -> no new fires
    expect(emptyA.events.length).toBe(0);
    // The world/queue/rng captured after an empty chunk must equal the input
    // continuation's (modulo nextTick, which is durationTicks+1 = same here).
    expect(JSON.stringify(emptyA.continuation)).toBe(JSON.stringify(a.continuation));
    // Resuming AFTER the empty chunk yields the same far-horizon stream as
    // resuming directly from `a.continuation`.
    const viaEmpty = runToHorizon(emptyA.continuation, 800, opts);
    const direct = runToHorizon(a.continuation, 800, opts);
    expect(hashStream(viaEmpty.events)).toBe(hashStream(direct.events));
  });

  it("repeated empty chunks (horizon held flat several times) never drift", () => {
    const seed = 42;
    const opts = ALL_ON;
    let cont = runToHorizon({ seed }, 200, opts).continuation;
    const snapshot = JSON.stringify(cont);
    for (let i = 0; i < 5; i += 1) {
      const step = runToHorizon(cont, 200, opts);
      expect(step.events.length).toBe(0);
      cont = step.continuation;
      expect(JSON.stringify(cont)).toBe(snapshot);
    }
  });

  it("horizon BEYOND all activity in one chunk equals chunked-to-the-same-horizon", () => {
    // With the default (no-flags) finite path, self-rescheduling tasks keep the
    // queue non-empty forever, so 'beyond all activity' means: a very large
    // horizon drained all-at-once == drained in tiny chunks. (No infinite loop
    // because the finite drain stops at the horizon.)
    const seed = 99;
    const big = 1500;
    const allAtOnce = simulate({ seed, durationTicks: big, ...ALL_ON });
    const chunked = chunkedStream(seed, big, 2, ALL_ON);
    expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
  });

  it("a boundary landing EXACTLY on the horizon tick fires that tick's tasks in-chunk", () => {
    // Tasks with fireTick === horizon MUST fire in the current chunk (the drain
    // condition is `fireTick > durationTicks`), and fireTick === horizon+1 is the
    // first of the next chunk. Drive boundaries straddling the 15-tick batch ticks.
    // Kept SHORT (h 600 < the ~1500 HOS key-order break) so this isolates the
    // boundary semantics, not the separately-asserted clock divergence.
    const seed = 1234;
    const opts = ALL_ON;
    for (const h of [15, 30] as const) {
      const onBoundary = chunkedStream(seed, 600, h, opts);
      const allAtOnce = simulate({ seed, durationTicks: 600, ...opts });
      expect(hashStream(onBoundary)).toBe(hashStream(allAtOnce));
    }
  });
});

// ---------------------------------------------------------------------------
// 4b. THE EXPOSED DETERMINISM BREAK — HOS clock JSON key-order divergence.
//
// FINDING (p19-fix adversarial run): with HOS enabled and a long-enough horizon
// (>= ~1500 ticks, so a driver accrues a mandatory mid-leg rest, that clock
// SURVIVES a chunk boundary via `serializeHosClock`, and is later re-emitted at
// the next dispatch), the chunked-via-continuation stream is NOT byte-identical
// to all-at-once. The ONLY difference is the JSON KEY ORDER of the `clock` object
// inside `DriverDutyStateChanged.payload.clock` ("trip-dispatched" emit, engine
// line ~1192): the restored clock has `serializeHosClock`'s field order, while
// the all-at-once clock has whatever builder produced it (e.g. the domain
// mid-leg reset builder at hos.ts:250 — `driveTodayMin, sinceLastBreakMin,
// dutyWindowStartAt, comeOnDutyAt, weeklyOnDutyMin, …`). Field VALUES are equal
// (canonical-key serialization shows ZERO diffs); only the serialized bytes differ.
//
// Why it matters: the project's OWN continuation-equivalence keystone hashes
// `JSON.stringify(event)` (key-order-sensitive). It misses this only because its
// HOS feature-case horizon is 800 (< 1500). The live demo runs HOS+fuel ON over
// the open-ended (chunked) path — exactly where this diverges.
//
// These tests are RED until the clock is serialized in a canonical key order at
// the emit boundary (the natural fix: have `emitDutyState` emit a canonicalized
// clock, or canonicalize `HosClock` construction project-wide). They go GREEN the
// moment the byte-identity contract is restored — at which point they are
// valuable regression coverage.
// ---------------------------------------------------------------------------

describe("adversarial: HOS clock JSON key-order is byte-stable across chunk boundaries (EXPOSED BUG)", () => {
  // THE HOS CHUNK-BOUNDARY REGRESSION — this caught a real determinism bug
  // (DriverDutyStateChanged.clock JSON key-order divergence after a driver
  // accrues a mid-leg rest whose clock survives a continuation boundary, only
  // visible at horizon ≥ ~1500). It is SEED-INDEPENDENT, so per p19-fix Step 1
  // we keep exactly ONE HOS-only case that crosses a boundary at h ≥ 1500. A
  // chunk-2 boundary (≈ horizon/2 resume cycles) is enough to cross the rest and
  // re-emit the restored clock — far cheaper than chunk-1 while keeping the
  // regression. DO NOT delete or shorten below h 1500.
  it("HOS-only chunked(2) is BYTE-identical to all-at-once (seed 1234, h 1600)", () => {
    const opts: FeatureOpts = { timing: SHORT_TIMING, hosEnabled: true };
    const allAtOnce = simulate({ seed: 1234, durationTicks: 1600, ...opts });
    const chunked = chunkedStream(1234, 1600, 2, opts);
    // Lengths + canonical values already match; this asserts BYTE-identity,
    // which regressed purely on DriverDutyStateChanged.clock key order.
    expect(chunked.length).toBe(allAtOnce.length);
    expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
  });

  it("ALL-features chunked(2) byte-identical at a long horizon (seed 99, h 1500)", () => {
    const allAtOnce = simulate({ seed: 99, durationTicks: 1500, ...ALL_ON });
    const chunked = chunkedStream(99, 1500, 2, ALL_ON);
    expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
  });
});

// ---------------------------------------------------------------------------
// 5. Cross-check: chunked HOS-only and fuel-only (single-stream isolation)
// ---------------------------------------------------------------------------

describe("adversarial: single-feature isolation across chunks", () => {
  const SINGLE: { name: string; opts: FeatureOpts }[] = [
    { name: "base-only (no flags)", opts: {} },
    { name: "rfid-only", opts: { timing: SHORT_TIMING, rfid: {} } },
    { name: "overCarry-only", opts: { timing: SHORT_TIMING, overCarry: 0.7 } },
    { name: "hos-only", opts: { timing: SHORT_TIMING, hosEnabled: true } },
    {
      name: "fuel-only (hos off)",
      opts: {
        timing: SHORT_TIMING,
        fuel: {
          enabled: true,
          milesPerGallon: 6,
          tankCapacityGallons: 200,
          refuelThresholdMiles: 100,
          refuelTimeMinutes: 30,
        },
      },
    },
  ];
  // Each feature here asserts a DISTINCT single-stream isolation property, so we
  // keep all five — but the chunk SIZE is pure repetition once one fine boundary
  // passes. We prove each feature once at a coarse chunk-3 (≈ 230 resumes at
  // h 700) and additionally pin the worst-case chunk-1 on a single representative
  // feature (hos-only, the one that exposed the real key-order bug) — p19-fix.
  for (const { name, opts } of SINGLE) {
    it(`${name}: chunked(3) byte-identical to all-at-once (seed 1234, h 700)`, () => {
      const allAtOnce = simulate({ seed: 1234, durationTicks: 700, ...opts });
      const chunked = chunkedStream(1234, 700, 3, opts);
      expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
      expect(chunked.length).toBe(allAtOnce.length);
    });
  }
  it("hos-only: chunked(1) byte-identical to all-at-once (seed 1234, h 700)", () => {
    const opts: FeatureOpts = { timing: SHORT_TIMING, hosEnabled: true };
    const allAtOnce = simulate({ seed: 1234, durationTicks: 700, ...opts });
    const chunked = chunkedStream(1234, 700, 1, opts);
    expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
    expect(chunked.length).toBe(allAtOnce.length);
  });
});
