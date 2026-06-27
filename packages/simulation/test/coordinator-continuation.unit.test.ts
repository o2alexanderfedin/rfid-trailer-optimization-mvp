import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FuelConfig } from "@mm/domain";
import { simulate, runToHorizon, type SimulatedEvent } from "../src/engine.js";
import type { SimContinuation } from "../src/continuation.js";

/**
 * Phase-25 COORD-04 — THE COORDINATOR CONTINUATION-EQUIVALENCE KEYSTONE (T-25-19).
 *
 * 25-02/03/04 wired the in-fold `stepCoordinators` pass + the same-tick accept/reject
 * handshake + the five anti-oscillation/anti-deadlock guards, but the guards carry
 * CROSS-TICK mutable state the centralized world maps did not previously serialize:
 *
 *   - `leaseByAgent`            (GUARD 4 — single-owner lease per target),
 *   - `rejectCountByOption`     (GUARDs 2+5 — reject count toward the K-prune),
 *   - `backoffUntilByOption`    (GUARD 2 — seeded-jitter exponential backoff),
 *   - `metricAboveSinceByOption`(GUARD 1 — hysteresis dead-band marker),
 *   - `lastCenterByAgent`       (GUARD 5 — zone-change prune-clear key),
 *
 * plus any cross-tick `pendingSuggestionsByTarget` (the within-tick handshake
 * substrate, serialized defensively). Until 25-05 these were in-process Maps, NOT
 * serialized — so a chunk boundary landing between two coordinator passes would
 * resume with EMPTY guard state, re-issuing a just-leased/backed-off/pruned
 * suggestion the all-at-once run suppressed, diverging the stream (the OODA
 * odometer-clobber class of bug).
 *
 * 25-05 captures all coordinator guard state into `SerializedWorldState`
 * (present-only-when-on shape) and restores it on resume. This test is the witness:
 * a coordinator-on run driven in CHUNKS via `runToHorizon` MUST be byte-identical to
 * the all-at-once `simulate()` — proving the guard state round-trips through the
 * continuation and no phantom unserialized coordinator state leaks across a boundary.
 *
 * The per-COORDINATOR RNG is a STATELESS re-derive (`deriveCoordinatorRng(seed,
 * centerId)` is rebuilt each pass from `seed`+centerId with NO stored stream
 * position; the backoff jitter draws per-pass from a freshly-derived rng), so there
 * is NO per-coordinator RNG state to serialize — the only new cross-tick coordinator
 * data are the five guard maps + the pending-suggestion substrate.
 */

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

const FUEL_ON: FuelConfig = {
  enabled: true,
  refuelThresholdMiles: 1200,
  milesPerGallon: 6.5,
  tankCapacityGallons: 150,
  refuelTimeMinutes: 30,
};

/**
 * A coordinator-on configuration that exercises the full handshake + all five guards:
 * one coordinator per center advises real OODA agents (trucks + hubs) over the natural
 * all-on demo stack, so the lease / reject-count / backoff / hysteresis / last-center
 * maps are populated with live state throughout the run (the state that MUST survive a
 * continuation). HOS + fuel are on so the agents can genuinely REJECT (the reject path
 * advances the backoff/prune guards — the cross-tick state most likely to desync).
 */
const COORD_OPTS = {
  coordinatorsEnabled: true,
  oodaAgentsEnabled: true,
  hosEnabled: true,
  fuel: FUEL_ON,
  inductionEnabled: true,
  consolidationEnabled: true,
} as const;

/**
 * Drive a finite coordinator-on run [0, horizonTick] entirely through the continuation
 * API in fixed `chunkSize`-tick steps, collecting the ordered event stream.
 */
function chunkedStream(seed: number, horizonTick: number, chunkSize: number): SimulatedEvent[] {
  const collected: SimulatedEvent[] = [];
  let continuation: SimContinuation | undefined;
  for (let target = chunkSize; ; target += chunkSize) {
    const horizon = Math.min(target, horizonTick);
    const start = continuation ?? { seed };
    const { events, continuation: next } = runToHorizon(start, horizon, COORD_OPTS);
    collected.push(...events);
    continuation = next;
    if (horizon >= horizonTick) break;
  }
  return collected;
}

describe("coordinator continuation-equivalence (COORD-04, the guard-state keystone)", () => {
  const SEED = 42;
  const HORIZON = 2000;

  it("a fresh runToHorizon to the horizon equals all-at-once (coordinator-on)", () => {
    const allAtOnce = simulate({ seed: SEED, durationTicks: HORIZON, ...COORD_OPTS });
    const { events } = runToHorizon({ seed: SEED }, HORIZON, COORD_OPTS);
    expect(hashStream(events)).toBe(hashStream(allAtOnce));
    expect(events.length).toBe(allAtOnce.length);
  });

  // Chunk-7 lands boundaries between successive coordinator passes (cadence 5) AND
  // mid-handshake (between a stepCoordinators pass that emits + leases + advances the
  // guard markers and the next pass that reads them) — the exact boundary that would
  // expose unserialized guard state.
  for (const chunk of [7, 23, 500]) {
    it(`chunked(${chunk}) == all-at-once with coordinators on (seed ${SEED}, h ${HORIZON})`, () => {
      const allAtOnce = simulate({ seed: SEED, durationTicks: HORIZON, ...COORD_OPTS });
      const chunked = chunkedStream(SEED, HORIZON, chunk);
      expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
      // Length must match too (a hash collision is astronomically unlikely, but the
      // count is a cheap independent witness).
      expect(chunked.length).toBe(allAtOnce.length);
    });
  }

  // Stronger boundary stress: chunk-1 lands a boundary at EVERY tick, including the
  // tick BETWEEN a coordinator pass (which acquires a lease + advances the hysteresis
  // marker) and the next pass — over a shorter horizon to bound the O(horizon)
  // resume-cycle count.
  it("chunked(1) == all-at-once with coordinators on (seed 42, h 600) — every-tick boundary", () => {
    const allAtOnce = simulate({ seed: SEED, durationTicks: 600, ...COORD_OPTS });
    const chunked = chunkedStream(SEED, 600, 1);
    expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
    expect(chunked.length).toBe(allAtOnce.length);
  });

  it("the captured continuation carries the coordinator guard state as plain data", () => {
    // Resume far enough that the guards have accrued live state (leases held,
    // hysteresis markers advanced, some options backed off / pruned).
    const { continuation } = runToHorizon({ seed: SEED }, 800, COORD_OPTS);
    // The guard state is present in the serialized world (present-only-when-on).
    expect(Array.isArray(continuation.world.leaseByAgent)).toBe(true);
    expect(Array.isArray(continuation.world.rejectCountByOption)).toBe(true);
    expect(Array.isArray(continuation.world.backoffUntilByOption)).toBe(true);
    expect(Array.isArray(continuation.world.metricAboveSinceByOption)).toBe(true);
    expect(Array.isArray(continuation.world.lastCenterByAgent)).toBe(true);
    expect(Array.isArray(continuation.world.pendingSuggestionsByTarget)).toBe(true);
    // The guards genuinely accrued state by tick 800 (not a vacuously-empty witness):
    // the hysteresis marker map advances on every coordinator pass with a candidate.
    expect(continuation.world.metricAboveSinceByOption.length).toBeGreaterThan(0);
    // It is plain JSON-round-trippable data (no closures / pointers leak in).
    const roundTripped = JSON.parse(JSON.stringify(continuation)) as SimContinuation;
    expect(roundTripped.world.leaseByAgent).toEqual(continuation.world.leaseByAgent);
    expect(roundTripped.world.rejectCountByOption).toEqual(continuation.world.rejectCountByOption);
    expect(roundTripped.world.metricAboveSinceByOption).toEqual(
      continuation.world.metricAboveSinceByOption,
    );
    expect(roundTripped.world.pendingSuggestionsByTarget).toEqual(
      continuation.world.pendingSuggestionsByTarget,
    );
    // Resuming from the JSON-revived continuation yields the SAME stream as resuming
    // from the in-memory one — proving NO non-serializable coordinator state leaks.
    const fromMemory = runToHorizon(continuation, 1500, COORD_OPTS);
    const fromJson = runToHorizon(roundTripped, 1500, COORD_OPTS);
    expect(hashStream(fromJson.events)).toBe(hashStream(fromMemory.events));
  });

  it("the captured guard-state arrays are sorted by key (deterministic byte order)", () => {
    const { continuation } = runToHorizon({ seed: SEED }, 800, COORD_OPTS);
    const isSortedByKey = (arr: readonly (readonly [string, unknown])[]): boolean =>
      arr.every((e, i) => i === 0 || arr[i - 1]![0] <= e[0]);
    expect(isSortedByKey(continuation.world.leaseByAgent)).toBe(true);
    expect(isSortedByKey(continuation.world.rejectCountByOption)).toBe(true);
    expect(isSortedByKey(continuation.world.backoffUntilByOption)).toBe(true);
    expect(isSortedByKey(continuation.world.metricAboveSinceByOption)).toBe(true);
    expect(isSortedByKey(continuation.world.lastCenterByAgent)).toBe(true);
    expect(isSortedByKey(continuation.world.pendingSuggestionsByTarget)).toBe(true);
  });

  it("coordinators off: every coordinator-state array is EMPTY (off path byte-identical)", () => {
    // With coordinators off, no stepCoordinators pass runs, so NO lease/prune/backoff/
    // hysteresis/last-center write ever happens and NO pending suggestion is recorded —
    // every captured array is `[]`, the serialized form byte-identical to pre-Phase-25.
    const { continuation } = runToHorizon({ seed: SEED }, 800, {
      oodaAgentsEnabled: true,
      hosEnabled: true,
      fuel: FUEL_ON,
      inductionEnabled: true,
      consolidationEnabled: true,
    });
    expect(continuation.world.leaseByAgent).toEqual([]);
    expect(continuation.world.rejectCountByOption).toEqual([]);
    expect(continuation.world.backoffUntilByOption).toEqual([]);
    expect(continuation.world.metricAboveSinceByOption).toEqual([]);
    expect(continuation.world.lastCenterByAgent).toEqual([]);
    expect(continuation.world.pendingSuggestionsByTarget).toEqual([]);
  });
});
