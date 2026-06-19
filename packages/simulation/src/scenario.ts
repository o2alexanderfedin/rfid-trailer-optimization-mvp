/**
 * SIM-04: Deterministic scenario-injection model.
 *
 * `applyScenario` is a pure, seeded transformation over the deterministic event
 * stream produced by the engine. It accepts a `ScenarioKnobs` object (the four
 * operator controls) and a seeded `Rng` (ALL randomness MUST flow through it —
 * NO `Date.now()`, NO unseeded `Math.random()`). Given the same stream + same
 * knobs + same rng-seed, the output is byte-identical.
 *
 * Design:
 *   - The transformation is ADDITIVE: knobs inject extra events or modify RFID
 *     emission; the original stream events are preserved in their original order,
 *     and the injected events are spliced in at their correct `occurredAt` timestamps.
 *   - Knobs are applied in a fixed, stable order: demandSpike → tripDelay →
 *     hubCongestion → sensorNoise. This order is the composability contract.
 *   - An absent knob (undefined field) is a strict no-op; the caller receives an
 *     event array that is structurally identical to the input stream for that knob.
 *
 * Determinism contract (T-01-15): no `Date.now()`, no unseeded `Math.random()`.
 * All entropy comes from the injected `rng`.
 */

import type { DomainEvent, PackageCreated, TrailerDocked } from "@mm/domain";
import type { Rng } from "./rng.js";
import type { SimulatedEvent } from "./engine.js";
import { USA_HUBS } from "./network/hubs.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The four operator controls for the SIM-04 scenario knobs.
 * All fields are optional; absent fields are no-ops.
 */
export interface ScenarioKnobs {
  /**
   * Adds simulated dock contention at the named hub: injects duplicate
   * `TrailerDocked` marker events representing extra dwell time (dock wait).
   * `level` is a fraction [0,1] where 0 = no extra dwell and 1 = always adds
   * extra docking events.
   */
  readonly hubCongestion?: {
    readonly hubId: string;
    /** Congestion level [0,1]: probability of adding an extra docked event. */
    readonly level: number;
  };

  /**
   * Adds travel time to trailers on the named route leg. The delay is applied
   * as an extra offset on affected `TrailerDeparted`/`TrailerArrivedAtHub`
   * events. `delayMin` is in simulated minutes.
   */
  readonly tripDelay?: {
    /** The routeId that will experience the delay (`fromHubId-toHubId`). */
    readonly routeId: string;
    /** Extra travel minutes (positive integer). */
    readonly delayMin: number;
  };

  /**
   * Creates additional packages at the named hub. `factor` is a multiplier
   * (e.g., 2 = twice as many packages as the baseline batch). All new packages
   * are generated deterministically from the injected `rng`.
   */
  readonly demandSpike?: {
    readonly hubId: string;
    /** Demand multiplier (>= 1). */
    readonly factor: number;
  };

  /**
   * Overrides the RFID sensor noise profile for this run. All `RfidObserved`
   * events in the stream are re-filtered using the `missRate` parameter so the
   * sensor-fusion engine exercises the noisy path. The `rssiNoise` parameter is
   * stored on the knobs for future use by the RFID emitter.
   */
  readonly sensorNoise?: {
    /** Fraction of reads to drop [0,1]. */
    readonly missRate: number;
    /** Gaussian RSSI jitter standard deviation (dBm units — future use). */
    readonly rssiNoise: number;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Add `delayMin` minutes (in domain-ms) to an ISO timestamp string. */
function shiftMs(iso: string, delayMin: number): string {
  const ms = new Date(iso).getTime() + delayMin * 60_000;
  return new Date(ms).toISOString();
}

/** Package size classes for synthetic packages. */
const SIZE_CLASSES = ["small", "medium", "large"] as const;

// ---------------------------------------------------------------------------
// applyScenario: the pure transformation
// ---------------------------------------------------------------------------

/**
 * Apply `knobs` to `stream`, returning a new ordered event array.
 *
 * Transformation contract (applied in fixed order):
 *  1. `demandSpike` — inject seeded `PackageCreated` events at the origin hub.
 *  2. `tripDelay` — shift affected `TrailerDeparted` / `TrailerArrivedAtHub`
 *     timestamps by `delayMin` minutes for the matching routeId.
 *  3. `hubCongestion` — inject extra `TrailerDocked` marker events at the named
 *     hub (representing dock-contention dwell time).
 *  4. `sensorNoise` — filter existing `RfidObserved` events with the new
 *     missRate; drops events whose seeded drop-decision fires.
 *
 * The output is stable-sorted by `occurredAt` to maintain the deterministic
 * total order after any timestamp shifts or injections.
 *
 * @param stream  The base deterministic event stream from `simulate(...)`.
 * @param knobs   The operator scenario controls. Absent fields are no-ops.
 * @param rng     A seeded `Rng`; ALL randomness flows through this — never
 *                `Math.random()` or `Date.now()`.
 */
export function applyScenario(
  stream: readonly SimulatedEvent[],
  knobs: ScenarioKnobs,
  rng: Rng,
): SimulatedEvent[] {
  // Short-circuit: no knobs ⇒ clone only (no-op, preserves original structure).
  if (
    knobs.demandSpike === undefined &&
    knobs.tripDelay === undefined &&
    knobs.hubCongestion === undefined &&
    knobs.sensorNoise === undefined
  ) {
    return stream.slice();
  }

  // Build the output in-order with fixed knob-application order.
  let working: SimulatedEvent[] = stream.slice();

  // Step 1: demandSpike — inject extra PackageCreated events.
  if (knobs.demandSpike !== undefined) {
    working = applyDemandSpike(working, knobs.demandSpike, rng);
  }

  // Step 2: tripDelay — shift affected departure/arrival timestamps.
  if (knobs.tripDelay !== undefined) {
    working = applyTripDelay(working, knobs.tripDelay);
  }

  // Step 3: hubCongestion — inject extra TrailerDocked marker events.
  if (knobs.hubCongestion !== undefined) {
    working = applyHubCongestion(working, knobs.hubCongestion, rng);
  }

  // Step 4: sensorNoise — re-filter RFID reads with the new miss rate.
  if (knobs.sensorNoise !== undefined) {
    working = applySensorNoise(working, knobs.sensorNoise, rng);
  }

  // Stable-sort by occurredAt to preserve deterministic ordering after any
  // timestamp shifts. Ties are broken by original insertion order (stable sort).
  // We use a keyed sort to avoid re-parsing ISO strings multiple times.
  const withMs = working.map((e, idx) => ({ e, ms: new Date(e.occurredAt).getTime(), idx }));
  withMs.sort((a, b) => a.ms !== b.ms ? a.ms - b.ms : a.idx - b.idx);
  return withMs.map((x) => x.e);
}

// ---------------------------------------------------------------------------
// Step 1: Demand spike — inject seeded PackageCreated events
// ---------------------------------------------------------------------------

function applyDemandSpike(
  stream: SimulatedEvent[],
  spike: NonNullable<ScenarioKnobs["demandSpike"]>,
  rng: Rng,
): SimulatedEvent[] {
  const { hubId, factor } = spike;
  if (factor <= 1) return stream;

  // Gather existing PackageCreated timestamps so we inject into the same windows.
  const createdAt = stream
    .filter((e) => e.event.type === "PackageCreated")
    .map((e) => e.occurredAt);

  if (createdAt.length === 0) {
    // No baseline packages — nothing to spike.
    return stream;
  }

  // Collect possible destination hubs (all hubs except the origin).
  const allHubIds = USA_HUBS.map((h) => h.hubId);
  const destHubs = allHubIds.filter((h) => h !== hubId);
  if (destHubs.length === 0) {
    // Only one hub in the network — use a synthetic destination.
    return stream;
  }

  // Number of extra packages: (factor - 1) × existing count (floor, at least 1).
  const extraCount = Math.max(1, Math.floor((factor - 1) * createdAt.length));

  const injected: SimulatedEvent[] = [];
  let pkgIdx = 90_000; // High counter avoids collisions with engine-generated IDs.

  for (let i = 0; i < extraCount; i++) {
    pkgIdx += 1;
    const packageId = `SPIKE-${String(pkgIdx).padStart(5, "0")}`;
    // Pick a creation time from the existing batch timestamps (seeded pick).
    const occurredAt = createdAt[rng.int(createdAt.length)]!;
    // Pick a destination spoke (seeded).
    const destHubId = destHubs[rng.int(destHubs.length)]!;
    const sizeClass = SIZE_CLASSES[rng.int(SIZE_CLASSES.length)]!;
    const weight = 1 + rng.int(50);

    const created: PackageCreated = {
      type: "PackageCreated",
      schemaVersion: 1,
      payload: {
        packageId,
        originHubId: hubId,
        destHubId,
        sizeClass,
        weight,
      },
    };
    injected.push({
      streamId: `package-${packageId}`,
      event: created,
      occurredAt,
    });
  }

  return [...stream, ...injected];
}

// ---------------------------------------------------------------------------
// Step 2: Trip delay — shift affected departure/arrival timestamps
// ---------------------------------------------------------------------------

/**
 * Parse the `fromHubId` and `toHubId` out of a routeId in the conventional
 * format `${fromHubId}-${toHubId}`. Returns `undefined` for unparseable IDs.
 * Note: this works for hub IDs that do not contain hyphens. For multi-word hub
 * IDs like "new-york", we attempt the LONGEST valid matching split by checking
 * against known hub IDs from the stream.
 */
function routeHubsFromStream(
  routeId: string,
  stream: readonly SimulatedEvent[],
): { from: string; to: string } | undefined {
  // Collect all known hub IDs from the stream.
  const hubIds = new Set<string>();
  for (const e of stream) {
    if (e.event.type === "HubRegistered") {
      hubIds.add(e.event.payload.hubId);
    }
    if (e.event.type === "TrailerDeparted") {
      hubIds.add(e.event.payload.fromHubId);
      hubIds.add(e.event.payload.toHubId);
    }
  }

  // Try all split points and find one where both halves are known hub IDs.
  for (let i = 1; i < routeId.length; i++) {
    const from = routeId.slice(0, i);
    const to = routeId.slice(i + 1);
    // The separator must be a dash.
    if (routeId[i] !== "-") continue;
    if (hubIds.has(from) && hubIds.has(to)) {
      return { from, to };
    }
  }

  // Fallback: simple first-dash split (for hub IDs without hyphens).
  const idx = routeId.indexOf("-");
  if (idx > 0 && idx < routeId.length - 1) {
    return { from: routeId.slice(0, idx), to: routeId.slice(idx + 1) };
  }

  return undefined;
}

function applyTripDelay(
  stream: SimulatedEvent[],
  delay: NonNullable<ScenarioKnobs["tripDelay"]>,
): SimulatedEvent[] {
  const { routeId, delayMin } = delay;
  if (delayMin <= 0) return stream;

  const hubs = routeHubsFromStream(routeId, stream);
  if (hubs === undefined) {
    // Non-parseable routeId — no-op (unknown route).
    return stream;
  }

  // Collect trip IDs on this route.
  const affectedTripIds = new Set<string>();
  for (const e of stream) {
    if (e.event.type === "TrailerDeparted") {
      const p = e.event.payload;
      if (p.fromHubId === hubs.from && p.toHubId === hubs.to) {
        affectedTripIds.add(p.tripId);
      }
    }
  }

  if (affectedTripIds.size === 0) {
    // No trips match the routeId — no-op.
    return stream;
  }

  // Shift the occurredAt of departure and arrival events for affected trips.
  return stream.map((e) => {
    if (
      e.event.type === "TrailerDeparted" &&
      affectedTripIds.has(e.event.payload.tripId)
    ) {
      return { ...e, occurredAt: shiftMs(e.occurredAt, delayMin) };
    }
    if (
      e.event.type === "TrailerArrivedAtHub" &&
      affectedTripIds.has(e.event.payload.tripId)
    ) {
      return { ...e, occurredAt: shiftMs(e.occurredAt, delayMin) };
    }
    return e;
  });
}

// ---------------------------------------------------------------------------
// Step 3: Hub congestion — inject extra TrailerDocked marker events
// ---------------------------------------------------------------------------

/**
 * Hub congestion is modelled as extra `TrailerDocked` events at the named hub:
 * each original `TrailerDocked` may be followed by an additional docked event
 * at a slightly later timestamp (representing dock-contention dwell). The
 * probability of injection is the `level` fraction (seeded for determinism).
 */
function applyHubCongestion(
  stream: SimulatedEvent[],
  congestion: NonNullable<ScenarioKnobs["hubCongestion"]>,
  rng: Rng,
): SimulatedEvent[] {
  const { hubId, level } = congestion;
  if (level <= 0) return stream;

  const injected: SimulatedEvent[] = [];

  for (const e of stream) {
    if (e.event.type === "TrailerDocked" && e.event.payload.hubId === hubId) {
      // Probabilistically inject an extra docked event (seeded by rng).
      if (rng.next() < level) {
        // The extra docked event is 1 tick (1 min) after the original.
        const extraAt = shiftMs(e.occurredAt, 1);
        const extra: TrailerDocked = {
          type: "TrailerDocked",
          schemaVersion: 1,
          payload: {
            trailerId: e.event.payload.trailerId,
            hubId: e.event.payload.hubId,
            dockDoorId: `${e.event.payload.dockDoorId}-CONGESTED`,
          },
        };
        injected.push({
          streamId: e.streamId,
          event: extra,
          occurredAt: extraAt,
        });
      }
    }
  }

  return [...stream, ...injected];
}

// ---------------------------------------------------------------------------
// Step 4: Sensor noise — re-filter RFID reads with the new miss rate
// ---------------------------------------------------------------------------

/**
 * Drop `RfidObserved` events based on the seeded `missRate`. Each read is
 * dropped independently using a single `rng.next()` draw (deterministic).
 */
function applySensorNoise(
  stream: SimulatedEvent[],
  noise: NonNullable<ScenarioKnobs["sensorNoise"]>,
  rng: Rng,
): SimulatedEvent[] {
  const { missRate } = noise;
  if (missRate <= 0) return stream;
  if (missRate >= 1) {
    // Drop ALL RFID reads.
    return stream.filter((e) => e.event.type !== "RfidObserved");
  }

  // Drop each RfidObserved event if the seeded draw is below missRate.
  return stream.filter((e) => {
    if (e.event.type === "RfidObserved") {
      return rng.next() >= missRate;
    }
    return true;
  });
}
