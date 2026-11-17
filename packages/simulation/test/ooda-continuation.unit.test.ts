import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FuelConfig } from "@mm/domain";
import { simulate, runToHorizon, type SimulatedEvent } from "../src/engine.js";
import type { SimContinuation } from "../src/continuation.js";

/**
 * Phase-24 OODA-05 — THE OODA CONTINUATION-EQUIVALENCE KEYSTONE (T-24-12).
 *
 * 24-02 wired the `stepAgents` SimTask (continuation-safe by construction — it is a
 * data variant on the `(fireTick, seq)` queue, captured in `queue.snapshot()`), but
 * the OODA truck Observe reads ONE piece of cross-tick mutable state the centralized
 * world maps do not carry: `activeTripByTrailer` (set at `departTrailer` ONLY when
 * `oodaAgentsEnabled`). Until 24-04 it was an in-process map, NOT serialized — so a
 * chunk boundary landing mid-leg would resume with an EMPTY trip context and the
 * next `stepAgents` pass would Observe a phantom (no-trip) truck, diverging from the
 * all-at-once run.
 *
 * 24-04 captures `activeTripByTrailer` into `SerializedWorldState` (present-only-
 * when-on shape) and restores it on resume. This test is the witness: an OODA-on run
 * driven in CHUNKS via `runToHorizon` MUST be byte-identical to the all-at-once
 * `simulate()` — proving the agent state round-trips through the continuation and no
 * phantom unserialized agent state leaks across a boundary.
 *
 * The per-agent RNG is a STATELESS re-derive (`deriveAgentRng(seed, id)` is rebuilt
 * each pass from `seed`+id with NO stored stream position), so there is no per-agent
 * RNG state to serialize — the only new cross-tick agent datum is the active trip.
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
 * An OODA-on configuration that exercises trucks AND hubs — agents own dispatch,
 * divert, rest, refuel, and consolidation, so `activeTripByTrailer` is populated
 * with live legs throughout the run (the state that MUST survive a continuation).
 */
const OODA_OPTS = {
  oodaAgentsEnabled: true,
  hosEnabled: true,
  fuel: FUEL_ON,
  inductionEnabled: true,
  consolidationEnabled: true,
} as const;

/**
 * Drive a finite OODA-on run [0, horizonTick] entirely through the continuation API
 * in fixed `chunkSize`-tick steps, collecting the ordered event stream.
 */
function chunkedStream(seed: number, horizonTick: number, chunkSize: number): SimulatedEvent[] {
  const collected: SimulatedEvent[] = [];
  let continuation: SimContinuation | undefined;
  for (let target = chunkSize; ; target += chunkSize) {
    const horizon = Math.min(target, horizonTick);
    const start = continuation ?? { seed };
    const { events, continuation: next } = runToHorizon(start, horizon, OODA_OPTS);
    collected.push(...events);
    continuation = next;
    if (horizon >= horizonTick) break;
  }
  return collected;
}

describe("OODA continuation-equivalence (OODA-05, the agent-layer keystone)", () => {
  const SEED = 42;
  const HORIZON = 2000;

  it("a fresh runToHorizon to the horizon equals all-at-once (OODA-on)", () => {
    const allAtOnce = simulate({ seed: SEED, durationTicks: HORIZON, ...OODA_OPTS });
    const { events } = runToHorizon({ seed: SEED }, HORIZON, OODA_OPTS);
    expect(hashStream(events)).toBe(hashStream(allAtOnce));
    expect(events.length).toBe(allAtOnce.length);
  });

  // Chunk-7 lands boundaries between successive OODA passes (cadence 5) AND mid-leg
  // (between a departTrailer that records the active trip and the next stepAgents
  // pass that observes it) — the exact boundary that would expose an unserialized
  // `activeTripByTrailer`.
  for (const chunk of [7, 23, 500]) {
    it(`chunked(${chunk}) == all-at-once with OODA on (seed ${SEED}, h ${HORIZON})`, () => {
      const allAtOnce = simulate({ seed: SEED, durationTicks: HORIZON, ...OODA_OPTS });
      const chunked = chunkedStream(SEED, HORIZON, chunk);
      expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
      // Length must match too (a hash collision is astronomically unlikely, but the
      // count is a cheap independent witness).
      expect(chunked.length).toBe(allAtOnce.length);
    });
  }

  // Stronger boundary stress: chunk-1 lands a boundary at EVERY tick, including the
  // tick BETWEEN a departTrailer (which writes activeTripByTrailer) and the next
  // OODA pass — over a shorter horizon to bound the O(horizon) resume-cycle count.
  it("chunked(1) == all-at-once with OODA on (seed 42, h 600) — every-tick boundary", () => {
    const allAtOnce = simulate({ seed: SEED, durationTicks: 600, ...OODA_OPTS });
    const chunked = chunkedStream(SEED, 600, 1);
    expect(hashStream(chunked)).toBe(hashStream(allAtOnce));
    expect(chunked.length).toBe(allAtOnce.length);
  });

  it("the captured continuation carries the active-trip context as plain data", () => {
    // Resume far enough that trailers are mid-leg with active trips recorded.
    const { continuation } = runToHorizon({ seed: SEED }, 400, OODA_OPTS);
    // The agent state is present in the serialized world (present-only-when-on).
    expect(Array.isArray(continuation.world.activeTripByTrailer)).toBe(true);
    // It is plain JSON-round-trippable data (no closures / pointers leak in).
    const roundTripped = JSON.parse(JSON.stringify(continuation)) as SimContinuation;
    expect(roundTripped.world.activeTripByTrailer).toEqual(
      continuation.world.activeTripByTrailer,
    );
    // Resuming from the JSON-revived continuation yields the SAME stream as resuming
    // from the in-memory one — proving NO non-serializable agent state leaks.
    const fromMemory = runToHorizon(continuation, 900, OODA_OPTS);
    const fromJson = runToHorizon(roundTripped, 900, OODA_OPTS);
    expect(hashStream(fromJson.events)).toBe(hashStream(fromMemory.events));
  });

  it("OODA off: the captured active-trip context is EMPTY (off path byte-identical)", () => {
    // With OODA off, departTrailer never writes activeTripByTrailer, so the captured
    // array is `[]` — the serialized form is byte-identical to pre-Phase-24.
    const { continuation } = runToHorizon({ seed: SEED }, 800, {
      hosEnabled: true,
      fuel: FUEL_ON,
      inductionEnabled: true,
      consolidationEnabled: true,
    });
    expect(continuation.world.activeTripByTrailer).toEqual([]);
  });
});
