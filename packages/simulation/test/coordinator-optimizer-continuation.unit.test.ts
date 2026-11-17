import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FuelConfig } from "@mm/domain";
import { simulate, runToHorizon, type SimulatedEvent } from "../src/engine.js";
import type { SimContinuation } from "../src/continuation.js";

/**
 * Phase-26 COORD-06 (Plan 03) — CONTINUATION-EQUIVALENCE FOR THE OPTIMIZER-ON MODEL.
 *
 * Plan 02 sourced the coordinator REROUTE kind from an in-fold pure `runEpoch` under
 * the `coordinatorUsesOptimizer` sub-flag. The continuation question: does that
 * optimizer path survive a chunk boundary?
 *
 * It does, with NO new SerializedWorldState field, because the in-fold reroute pass is
 * RECOMPUTED PURELY FROM ALREADY-SERIALIZED FOLD STATE each tick:
 *
 *   - the reroute-driving congestion signal is read from the FROZEN per-center
 *     observation built at pass entry (from the engine fold maps that already
 *     serialize), `detectAffectedScope` + `partitionScopeByCenter` are pure functions
 *     of those events, `buildCenterTwinFromFold` projects the frozen fold slice, and
 *     `runEpoch` is a PURE function of (epoch, twin, weights) — no stored stream
 *     position, no cross-tick optimizer memo, no new mutable map.
 *   - the per-coordinator RNG is a STATELESS re-derive (`deriveCoordinatorRng(seed,
 *     centerId)` rebuilt each pass) — unchanged by the sub-flag.
 *   - the only cross-tick coordinator state remains the five Phase-25 guard maps +
 *     `pendingSuggestionsByTarget` (serialized in 25-05); the sub-flag changes ONLY
 *     the reroute candidate SOURCE, never the guard/emit/handshake substrate.
 *
 * So a coordinatorUsesOptimizer-on run driven in CHUNKS via `runToHorizon` MUST be
 * byte-identical to all-at-once `simulate()` — this test is the witness, mirroring
 * coordinator-continuation.unit.test.ts with the sub-flag on. If a serialization gap
 * existed (the in-fold runEpoch reading transient per-pass state that must survive a
 * boundary), a chunk boundary mid-pass would desync; it does not.
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
 * The optimizer-ON coordinator config: the Phase-25 all-on coordinator stack +
 * `coordinatorUsesOptimizer: true`, so the in-fold `runEpoch` reroute pass runs every
 * coordinator cadence over a live (congested) per-center scope throughout the run —
 * the path that MUST reproduce across a chunk boundary. HOS + fuel are on so the
 * agents can genuinely REJECT (the reject path advances the cross-tick guard state).
 */
const OPT_OPTS = {
  coordinatorsEnabled: true,
  coordinatorUsesOptimizer: true,
  oodaAgentsEnabled: true,
  hosEnabled: true,
  fuel: FUEL_ON,
  inductionEnabled: true,
  consolidationEnabled: true,
} as const;

/**
 * Drive a finite optimizer-on run [0, horizonTick] entirely through the continuation
 * API in fixed `chunkSize`-tick steps, collecting the ordered event stream.
 */
function chunkedStream(seed: number, horizonTick: number, chunkSize: number): SimulatedEvent[] {
  const collected: SimulatedEvent[] = [];
  let continuation: SimContinuation | undefined;
  for (let target = chunkSize; ; target += chunkSize) {
    const horizon = Math.min(target, horizonTick);
    const start = continuation ?? { seed };
    const { events, continuation: next } = runToHorizon(start, horizon, OPT_OPTS);
    collected.push(...events);
    continuation = next;
    if (horizon >= horizonTick) break;
  }
  return collected;
}

describe("optimizer-on continuation-equivalence (COORD-06, in-fold runEpoch across a boundary)", () => {
  const SEED = 42;
  const HORIZON = 2000;

  it("a fresh runToHorizon to the horizon equals all-at-once (optimizer-on)", () => {
    const allAtOnce = simulate({ seed: SEED, durationTicks: HORIZON, ...OPT_OPTS });
    const { events } = runToHorizon({ seed: SEED }, HORIZON, OPT_OPTS);
    expect(hashStream(events)).toBe(hashStream(allAtOnce));
    expect(events.length).toBe(allAtOnce.length);
  });

  // Chunk 7/23/500 land boundaries between successive coordinator passes (cadence 5)
  // AND mid-handshake — the boundary that would expose any unserialized in-fold
  // optimizer state (there is none; the reroute pass is recomputed from fold state).
  for (const chunk of [7, 23, 500]) {
    it(`chunked(${chunk}) == all-at-once with the optimizer on (seed ${SEED}, h ${HORIZON})`, () => {
      const allAtOnce = simulate({ seed: SEED, durationTicks: HORIZON, ...OPT_OPTS });
      const chunked = chunkedStream(SEED, HORIZON, chunk);
      expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
      expect(chunked.length).toBe(allAtOnce.length);
    });
  }

  // Chunk-1 lands a boundary at EVERY tick — the strongest stress, including the tick
  // BETWEEN a coordinator pass (which runs runEpoch + leases + advances the guards)
  // and the next pass — over a shorter horizon to bound the resume-cycle count.
  it("chunked(1) == all-at-once with the optimizer on (seed 42, h 600) — every-tick boundary", () => {
    const allAtOnce = simulate({ seed: SEED, durationTicks: 600, ...OPT_OPTS });
    const chunked = chunkedStream(SEED, 600, 1);
    expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
    expect(chunked.length).toBe(allAtOnce.length);
  });

  it("the JSON round-trip of the optimizer-on continuation resumes to the same stream", () => {
    // Resume far enough that the guards have accrued live state AND many in-fold
    // runEpoch reroute passes have fired.
    const { continuation } = runToHorizon({ seed: SEED }, 800, OPT_OPTS);
    // The continuation is plain JSON-round-trippable data (no closures / pointers).
    const roundTripped = JSON.parse(JSON.stringify(continuation)) as SimContinuation;
    // Resuming from the JSON-revived continuation yields the SAME stream as resuming
    // from the in-memory one — proving NO non-serializable in-fold optimizer state
    // leaks across the boundary (the runEpoch pass is recomputed from fold state).
    const fromMemory = runToHorizon(continuation, 1500, OPT_OPTS);
    const fromJson = runToHorizon(roundTripped, 1500, OPT_OPTS);
    expect(hashStream(fromJson.events)).toBe(hashStream(fromMemory.events));
  });

  it("the optimizer-on continuation introduces NO new SerializedWorldState field beyond the Phase-25 set", () => {
    // The sub-flag changes ONLY the reroute candidate SOURCE; the persisted coordinator
    // state is the SAME five guard maps + the pending substrate the rule-based path uses
    // (Plan 02 added NO new persisted field). The optimizer reroute pass is recomputed
    // from already-serialized fold state each tick, so the captured world has exactly
    // the Phase-25 coordinator fields (present-only-when-on) and no extra optimizer key.
    const { continuation } = runToHorizon({ seed: SEED }, 800, OPT_OPTS);
    const w = continuation.world as unknown as Record<string, unknown>;
    // The Phase-25 coordinator guard fields are present (the on path populated them).
    for (const field of [
      "leaseByAgent",
      "rejectCountByOption",
      "backoffUntilByOption",
      "metricAboveSinceByOption",
      "lastCenterByAgent",
      "pendingSuggestionsByTarget",
    ]) {
      expect(Array.isArray(w[field])).toBe(true);
    }
    // No optimizer-specific cross-tick field was added (no key whose name implies a
    // persisted optimizer/epoch/runEpoch memo — the in-fold pass is stateless).
    const optimizerishKey = Object.keys(w).find((k) =>
      /optimizer|runepoch|epochmemo|rerouteMemo/i.test(k),
    );
    expect(optimizerishKey).toBeUndefined();
  });

  it("the optimizer-on world fields match the rule-based coordinator-on world field SET (same persisted state)", () => {
    // The optimizer-on and rule-based coordinator-on runs serialize the SAME world
    // field NAMES (the sub-flag adds no persisted field) — the keys are identical.
    const optWorld = runToHorizon({ seed: SEED }, 800, OPT_OPTS).continuation.world as unknown as Record<
      string,
      unknown
    >;
    const ruleWorld = runToHorizon({ seed: SEED }, 800, {
      coordinatorsEnabled: true,
      oodaAgentsEnabled: true,
      hosEnabled: true,
      fuel: FUEL_ON,
      inductionEnabled: true,
      consolidationEnabled: true,
    }).continuation.world as unknown as Record<string, unknown>;
    expect(Object.keys(optWorld).sort()).toEqual(Object.keys(ruleWorld).sort());
  });

  it("the optimizer-on off path ([]) is byte-identical to pre-Phase-26 (no new behavior when off)", () => {
    // With the sub-flag OFF (here: coordinators also off, the pure off path), no
    // coordinator/optimizer state is written — every coordinator-state array is [] and
    // the serialized form is byte-identical to pre-Phase-25/26 (the [] witness).
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

  it("coordinatorUsesOptimizer: true with coordinators OFF is byte-identical to coordinators off (strict sub-flag)", () => {
    // The sub-flag is strict: with coordinators off it changes nothing, so a chunked
    // run with the sub-flag set (coordinators off) equals the plain off run.
    const off = simulate({
      seed: SEED,
      durationTicks: 800,
      oodaAgentsEnabled: true,
      hosEnabled: true,
      fuel: FUEL_ON,
      inductionEnabled: true,
      consolidationEnabled: true,
    });
    const offWithSubFlag = simulate({
      seed: SEED,
      durationTicks: 800,
      oodaAgentsEnabled: true,
      hosEnabled: true,
      fuel: FUEL_ON,
      inductionEnabled: true,
      consolidationEnabled: true,
      coordinatorUsesOptimizer: true,
    });
    expect(JSON.stringify(offWithSubFlag)).toBe(JSON.stringify(off));
  });
});
