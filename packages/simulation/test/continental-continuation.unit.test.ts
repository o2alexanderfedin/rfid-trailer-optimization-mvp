import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FuelConfig } from "@mm/domain";
import { simulate, runToHorizon, type SimulatedEvent } from "../src/engine.js";
import type { SimContinuation } from "../src/continuation.js";
import { FLAGS_OFF_GOLDEN_SHA256, CONTINENTAL_GOLDEN_SHA256 } from "./goldens.js";

/**
 * Phase-28 DET-02 — GAP-2: THE CONTINENTAL CONTINUATION-EQUIVALENCE WITNESS.
 *
 * The 4 existing continuation suites cover OODA-on, coordinator-on,
 * optimizer-on, and v2.0-ALL_ON (chunked == all-at-once, chunks 1/7/23/500).
 * None of them drives `continentalTopology: true`.  This test is the witness:
 * a continental run driven in CHUNKS via `runToHorizon` MUST be byte-identical
 * to the all-at-once `simulate()` — closing GAP-2.
 *
 * Why does the continental topology need a dedicated continuation test?
 *
 * The continental routing structure (hub→center partition, backbone legs, per-leg
 * transit params) is BUILT ONCE at engine bootstrap and is NOT carried in
 * `SerializedWorldState` — it is a function of the opts, re-derived on every
 * `runToHorizon` call from the same flag and the same deterministic
 * `generateBigCityHubs()` list (a pure, seedless function).  Because no new
 * per-tick continental state lives in the continuation, a chunk boundary landing
 * mid-leg SHOULD never diverge from all-at-once.
 *
 * The key risks the test guards against:
 *
 *   1. A per-tick continental routing decision (e.g., `arriveOverCarriedAtCenter`
 *      `centerHubId?` or `arriveConsolidationAtCenter` `centerHubId?`) that
 *      depends on engine-level mutable state beyond the serialized world — if such
 *      state leaked across a boundary the chunked stream would diverge.
 *
 *   2. The continental topology tasks (`arriveOverCarriedAtCenter`,
 *      `arriveConsolidationAtCenter`) carry an optional `centerHubId?` field
 *      (present only under `continentalTopology`).  These tasks ARE serialized via
 *      the `SimTask` union in `SimContinuation.queue` — so a chunk boundary between
 *      a continental-arrival schedule and its fire MUST still reconstruct the same
 *      `centerHubId`.  This test is the regression guard for that path.
 *
 * The analog in the continuation family: `ooda-continuation.unit.test.ts` (the
 * structural template this file mirrors).
 *
 * Note on `FLAGS_OFF_GOLDEN_SHA256` and `CONTINENTAL_GOLDEN_SHA256` below:
 *   - They are imported for reference context only.
 *   - NO assertion in this file depends on them; all assertions are RELATIVE
 *     (hashStream(chunked) === hashStream(allAtOnce)).
 *   - This is intentional — the continuation equivalence property is
 *     architecture-stable; baking a NEW simulate() golden for the continental
 *     continuation run would be a perf risk (the full ~92-hub engine path).
 */
void FLAGS_OFF_GOLDEN_SHA256;   // imported for audit reference — see goldens.ts
void CONTINENTAL_GOLDEN_SHA256; // imported for audit reference — see goldens.ts

// ---------------------------------------------------------------------------
// Helpers (verbatim from ooda-continuation.unit.test.ts)
// ---------------------------------------------------------------------------

/** Stable, pointer-free serialization of one event (domain ids only). */
function serializeEvent(e: SimulatedEvent): string {
  return `${e.streamId} ${e.occurredAt} ${JSON.stringify(e.event)}`;
}

/** SHA-256 over the ordered stream (stable serialization, no object identity). */
function hashStream(stream: readonly SimulatedEvent[]): string {
  const h = createHash("sha256");
  for (const e of stream) {
    h.update(serializeEvent(e));
    h.update(""); // record separator
  }
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------

const FUEL_ON: FuelConfig = {
  enabled: true,
  refuelThresholdMiles: 1200,
  milesPerGallon: 6.5,
  tankCapacityGallons: 150,
  refuelTimeMinutes: 30,
};

/**
 * The BASE continental configuration: continentalTopology alone, plus the
 * supporting flags that exercise cross-center freight flow (HOS + fuel for
 * realistic leg distances; induction + consolidation for spoke→center→backbone
 * freight paths).
 *
 * This exercises the `arriveOverCarriedAtCenter.centerHubId?` and
 * `arriveConsolidationAtCenter.centerHubId?` task variants that the continental
 * topology introduces — exactly the cross-tick serialized tasks the continuation
 * guard must round-trip correctly.
 */
const CONTINENTAL_OPTS = {
  continentalTopology: true,
  hosEnabled: true,
  fuel: FUEL_ON,
  inductionEnabled: true,
  consolidationEnabled: true,
} as const;

/**
 * The FULL all-on stack: continental + OODA agents + coordinators + optimizer.
 * Used in the stacked-flag describe block (DET-02 broader coverage).
 */
const ALL_ON_OPTS = {
  continentalTopology: true,
  oodaAgentsEnabled: true,
  coordinatorsEnabled: true,
  coordinatorUsesOptimizer: true,
  hosEnabled: true,
  fuel: FUEL_ON,
  inductionEnabled: true,
  consolidationEnabled: true,
} as const;

// ---------------------------------------------------------------------------
// chunkedStream — generic, opts-parameterised (needed for two flag combos)
// ---------------------------------------------------------------------------

/**
 * Drive a finite run [0, horizonTick] entirely through the continuation API in
 * fixed `chunkSize`-tick steps using the given opts, collecting the ordered
 * event stream.  Mirrors the same function in `ooda-continuation.unit.test.ts`
 * except opts is a parameter (not a module-level constant) so both
 * CONTINENTAL_OPTS and ALL_ON_OPTS can reuse it.
 */
function chunkedStream(
  seed: number,
  horizonTick: number,
  chunkSize: number,
  opts: Omit<Parameters<typeof runToHorizon>[2], never>,
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

// ---------------------------------------------------------------------------
// DESCRIBE 1: continental continuation-equivalence (the GAP-2 keystone)
// ---------------------------------------------------------------------------

describe("continental continuation-equivalence (DET-02, the continental-topology keystone)", () => {
  const SEED = 42;
  const HORIZON = 2000;

  it("a fresh runToHorizon to the horizon equals all-at-once (continentalTopology on)", () => {
    const allAtOnce = simulate({ seed: SEED, durationTicks: HORIZON, ...CONTINENTAL_OPTS });
    const { events } = runToHorizon({ seed: SEED }, HORIZON, CONTINENTAL_OPTS);
    expect(hashStream(events)).toBe(hashStream(allAtOnce));
    expect(events.length).toBe(allAtOnce.length);
  });

  // Chunk-7 lands boundaries between successive continental arrival tasks AND mid-leg
  // (between a departTrailer that schedules an `arriveOverCarriedAtCenter` / hub-arrival
  // task carrying `centerHubId?` and the tick that fires it) — the exact boundary that
  // would expose any unserialized continental routing state.
  for (const chunk of [7, 23, 500]) {
    it(
      `chunked(${chunk}) == all-at-once with continentalTopology on (seed ${SEED}, h ${HORIZON})`,
      () => {
        const allAtOnce = simulate({ seed: SEED, durationTicks: HORIZON, ...CONTINENTAL_OPTS });
        const chunked = chunkedStream(SEED, HORIZON, chunk, CONTINENTAL_OPTS);
        expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
        // Length must match too (a hash collision is astronomically unlikely, but the
        // count is a cheap independent witness).
        expect(chunked.length).toBe(allAtOnce.length);
      },
    );
  }

  // Stronger boundary stress: chunk-1 lands a boundary at EVERY tick, including the
  // tick BETWEEN a continental-arrival schedule and its fire — over a shorter horizon
  // to bound the O(horizon) resume-cycle count.
  it(
    "chunked(1) == all-at-once with continentalTopology on (seed 42, h 600) — every-tick boundary",
    () => {
      const allAtOnce = simulate({ seed: SEED, durationTicks: 600, ...CONTINENTAL_OPTS });
      const chunked = chunkedStream(SEED, 600, 1, CONTINENTAL_OPTS);
      expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
      expect(chunked.length).toBe(allAtOnce.length);
    },
  );

  it("the captured continuation carries the continental topology state as plain data", () => {
    // Resume far enough that trailers are mid-leg on continental routes (spoke→center
    // and cross-center backbone legs in flight with scheduled `centerHubId?` tasks).
    const { continuation } = runToHorizon({ seed: SEED }, 400, CONTINENTAL_OPTS);
    // ARCHITECTURAL NOTE: the continental routing structure (hub→center partition,
    // backbone legs, per-leg transit params) is built ONCE at bootstrap and is NOT
    // stored in SerializedWorldState.  It is re-derived from opts on every
    // runToHorizon call — so there are NO new continental-specific fields in the
    // continuation DTO.  The existing world fields (`pendingBySpoke`, `pendingAtSpoke`,
    // `consolidationDestByPackage`, etc.) carry the continental freight state exactly
    // as they do for the legacy path; the `SimTask` variants
    // `arriveOverCarriedAtCenter` and `arriveConsolidationAtCenter` carry `centerHubId?`
    // as DATA in the queue snapshot (not as closure state) — continuation-safe by
    // construction.
    //
    // This test therefore checks: (a) the continuation is JSON-round-trippable
    // (no continental-specific closures or pointers leaked in), and (b) resuming from
    // the JSON-revived continuation yields the SAME stream as resuming from the
    // in-memory one — the actual regression question.

    // The continuation is plain JSON-round-trippable data (no closures / pointers).
    const roundTripped = JSON.parse(JSON.stringify(continuation)) as SimContinuation;
    // The serialized world round-trips faithfully.
    expect(roundTripped.world.pendingBySpoke).toEqual(continuation.world.pendingBySpoke);
    expect(roundTripped.world.pendingAtSpoke).toEqual(continuation.world.pendingAtSpoke);
    expect(roundTripped.world.consolidationDestByPackage).toEqual(
      continuation.world.consolidationDestByPackage,
    );
    expect(roundTripped.queue).toEqual(continuation.queue);
    // Resuming from the JSON-revived continuation yields the SAME stream as resuming
    // from the in-memory one — proving NO non-serializable continental state leaks.
    const fromMemory = runToHorizon(continuation, 900, CONTINENTAL_OPTS);
    const fromJson = runToHorizon(roundTripped, 900, CONTINENTAL_OPTS);
    expect(hashStream(fromJson.events)).toBe(hashStream(fromMemory.events));
  });

  it(
    "continentalTopology off: the continuation round-trips identically to the legacy path",
    () => {
      // With continentalTopology absent/false, no continental task variants are
      // scheduled, so the queue never contains `centerHubId?` fields and the
      // world maps carry the same byte layout as the pre-Phase-23 legacy path.
      // This is a relative continuation-equivalence assertion, NOT a golden assertion.
      const LEGACY_OPTS = {
        hosEnabled: true,
        fuel: FUEL_ON,
        inductionEnabled: true,
        consolidationEnabled: true,
      } as const;
      const allAtOnce = simulate({ seed: SEED, durationTicks: 800, ...LEGACY_OPTS });
      const chunked = chunkedStream(SEED, 800, 23, LEGACY_OPTS);
      expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
      expect(chunked.length).toBe(allAtOnce.length);
    },
  );
});

// ---------------------------------------------------------------------------
// DESCRIBE 2: stacked continuation-equivalence (continental + agents + optimizer)
// ---------------------------------------------------------------------------

describe(
  "continental + OODA + coordinator + optimizer stacked continuation-equivalence (DET-02)",
  () => {
    const SEED = 42;
    // Shorter horizon: the full all-on stack runs all subsystems concurrently (OODA
    // agents, coordinators, optimizer, continental routing) — 1200 ticks exercises
    // cross-center freight flow through multiple coordinator + OODA pass cycles while
    // keeping the test runtime reasonable.
    const HORIZON = 1200;

    it(
      "chunked(7) == all-at-once with full all-on stack (continental + agents + coordinators + optimizer)",
      () => {
        const allAtOnce = simulate({ seed: SEED, durationTicks: HORIZON, ...ALL_ON_OPTS });
        const chunked = chunkedStream(SEED, HORIZON, 7, ALL_ON_OPTS);
        expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
        // Independent length witness (T-28-05: hash collision + matching length is
        // astronomically unlikely — two independent witnesses).
        expect(chunked.length).toBe(allAtOnce.length);
      },
    );

    it("chunked(23) == all-at-once with full all-on stack", () => {
      const allAtOnce = simulate({ seed: SEED, durationTicks: HORIZON, ...ALL_ON_OPTS });
      const chunked = chunkedStream(SEED, HORIZON, 23, ALL_ON_OPTS);
      expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
      expect(chunked.length).toBe(allAtOnce.length);
    });

    it("chunked(500) == all-at-once with full all-on stack", () => {
      const allAtOnce = simulate({ seed: SEED, durationTicks: HORIZON, ...ALL_ON_OPTS });
      const chunked = chunkedStream(SEED, HORIZON, 500, ALL_ON_OPTS);
      expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
      expect(chunked.length).toBe(allAtOnce.length);
    });

    // chunk-1 over the full all-on stack (5 subsystems × every tick) would be very
    // slow; the per-subsystem continuation tests cover chunk-1 individually, so we
    // rely on those for the every-tick boundary stress here.
  },
);
