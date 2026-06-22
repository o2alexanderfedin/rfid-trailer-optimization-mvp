import { describe, expect, it } from "vitest";
import { simulate, type SimulatedEvent } from "../src/engine.js";
import { DEFAULT_TIMING_CONFIG } from "../src/timing.js";
import { USA_HUBS } from "../src/network/hubs.js";
import { buildTransitParamsByLeg, routeId } from "../src/network/routes.js";

/**
 * SIM-02 timing in the engine — the variance + determinism contract.
 *
 * The engine now draws DWELL (per arrival, by hub role) and TRANSIT (per
 * departure) from the seeded log-normal sampler via a DEDICATED timing rng. Over
 * a seeded run those durations must VARY (no longer the fixed 10/30), stay within
 * the configured clamp band, and — the keystone — remain byte-identical for a
 * fixed seed (the timing draws happen in deterministic event-queue order).
 */

const SEED = 4242;
// TIME-01: per-leg transit medians are now ≈400–2250 min (real great-circle
// distance / 80 km/h), so the horizon must be long enough for many round-trips
// across SHORT and LONG legs alike ⇒ many dwell + transit draws.
const TICKS = 8000;
const EPOCH = Date.parse("2026-04-01T00:00:00.000Z");
const MS_PER_TICK = 60_000;
const tick = (iso: string): number => Math.round((Date.parse(iso) - EPOCH) / MS_PER_TICK);

interface Departure {
  readonly trailerId: string;
  readonly tripId: string;
  readonly tick: number;
  readonly fromHubId: string;
  readonly toHubId: string;
}

/** One realized transit: its directed routeId + the elapsed ticks. */
interface LegTransit {
  readonly routeKey: string;
  readonly ticks: number;
}

/** Recover per-leg transit ticks (arrival tick − its departure tick, by tripId). */
function transitLegs(stream: readonly SimulatedEvent[]): LegTransit[] {
  const departByTrip = new Map<string, Departure>();
  const out: LegTransit[] = [];
  for (const s of stream) {
    if (s.event.type === "TrailerDeparted") {
      departByTrip.set(s.event.payload.tripId, {
        trailerId: s.event.payload.trailerId,
        tripId: s.event.payload.tripId,
        tick: tick(s.occurredAt),
        fromHubId: s.event.payload.fromHubId,
        toHubId: s.event.payload.toHubId,
      });
    } else if (s.event.type === "TrailerArrivedAtHub") {
      const dep = departByTrip.get(s.event.payload.tripId);
      if (dep !== undefined) {
        out.push({ routeKey: routeId(dep.fromHubId, dep.toHubId), ticks: tick(s.occurredAt) - dep.tick });
      }
    }
  }
  return out;
}

/**
 * Recover per-trailer TURNAROUND ticks: the gap between an ARRIVAL and that
 * trailer's NEXT outbound (center-origin) departure. Since TIME-02 a turnaround
 * spans TWO role-keyed dwells — one `dwellSpoke` at the spoke plus one
 * `dwellCenter` at the center re-dispatch boundary — so the gap lies in the SUM
 * of both bands. Skips the over-carried return arrival at the center (a terminal
 * unload, not a dwell-then-redispatch).
 */
function dwellTicks(stream: readonly SimulatedEvent[]): number[] {
  const lastArrivalTick = new Map<string, number>();
  const out: number[] = [];
  for (const s of stream) {
    if (s.event.type === "TrailerArrivedAtHub") {
      lastArrivalTick.set(s.event.payload.trailerId, tick(s.occurredAt));
    } else if (s.event.type === "TrailerDeparted" && s.event.payload.fromHubId === "MEM") {
      const arr = lastArrivalTick.get(s.event.payload.trailerId);
      if (arr !== undefined) {
        out.push(tick(s.occurredAt) - arr);
        lastArrivalTick.delete(s.event.payload.trailerId);
      }
    }
  }
  return out;
}

describe("engine log-normal timing (SIM-02)", () => {
  it("transit ticks VARY across legs and stay within EACH leg's per-leg [min,max] (TIME-01)", () => {
    const stream = simulate({ seed: SEED, durationTicks: TICKS });
    const legs = transitLegs(stream);
    const t = legs.map((l) => l.ticks);
    expect(t.length).toBeGreaterThan(10);
    // Real variance — not all equal (the old fixed 30), and now ALSO varying by
    // leg (short regional vs long coast medians differ ~5×).
    expect(new Set(t).size).toBeGreaterThan(1);
    // TIME-01: each realized transit sits within ITS OWN geography-derived band
    // (the per-leg medians are derived from real great-circle distance), not the
    // old single global transit band.
    const byLeg = buildTransitParamsByLeg(USA_HUBS, DEFAULT_TIMING_CONFIG.transit.sigma);
    for (const { routeKey, ticks } of legs) {
      const p = byLeg.get(routeKey);
      expect(p, `expected per-leg params for ${routeKey}`).toBeDefined();
      expect(ticks).toBeGreaterThanOrEqual(Math.max(1, p!.min));
      expect(ticks).toBeLessThanOrEqual(p!.max);
    }
  });

  it("turnaround dwell ticks VARY across arrivals and stay within the summed [min,max] (spoke + center)", () => {
    const stream = simulate({ seed: SEED, durationTicks: TICKS });
    const d = dwellTicks(stream);
    expect(d.length).toBeGreaterThan(5);
    // Real variance — not all equal (the old fixed 10).
    expect(new Set(d).size).toBeGreaterThan(1);
    // TIME-02: a turnaround = one spoke dwell + one center re-dispatch dwell, so
    // the realized gap lies within the SUM of both role bands.
    const { dwellSpoke, dwellCenter } = DEFAULT_TIMING_CONFIG;
    const min = dwellSpoke.min + dwellCenter.min;
    const max = dwellSpoke.max + dwellCenter.max;
    for (const v of d) {
      expect(v).toBeGreaterThanOrEqual(min);
      expect(v).toBeLessThanOrEqual(max);
    }
  });

  it("same seed ⇒ byte-identical stream (timing draws are deterministic)", () => {
    const a = simulate({ seed: SEED, durationTicks: TICKS });
    const b = simulate({ seed: SEED, durationTicks: TICKS });
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("a different timing config changes timestamps but the stream stays reproducible", () => {
    const base = simulate({ seed: SEED, durationTicks: TICKS });
    const fast = simulate({
      seed: SEED,
      durationTicks: TICKS,
      timing: {
        dwellSpoke: { median: 5, sigma: 0.1, min: 1, max: 20 },
        dwellCenter: { median: 5, sigma: 0.1, min: 1, max: 20 },
        transit: { median: 8, sigma: 0.1, min: 1, max: 20 },
      },
    });
    // A faster config yields a different (shorter-leg) stream...
    expect(JSON.stringify(fast)).not.toBe(JSON.stringify(base));
    // ...yet remains fully reproducible for the same seed + config.
    const fast2 = simulate({
      seed: SEED,
      durationTicks: TICKS,
      timing: {
        dwellSpoke: { median: 5, sigma: 0.1, min: 1, max: 20 },
        dwellCenter: { median: 5, sigma: 0.1, min: 1, max: 20 },
        transit: { median: 8, sigma: 0.1, min: 1, max: 20 },
      },
    });
    expect(JSON.stringify(fast2)).toBe(JSON.stringify(fast));
  });

  it("the injected timing rng does NOT perturb the operational rng (package stream unchanged vs a baseline with pinned timing)", () => {
    // Pin timing to a constant so transit/dwell are fixed, then the package/RFID
    // decisions must be identical regardless of the timing distribution — proving
    // the timing substream is orthogonal to the operational substream.
    const pinned = { median: 30, sigma: 0, min: 30, max: 30 };
    const pinnedDwell = { median: 10, sigma: 0, min: 10, max: 10 };
    const cfgA = { dwellSpoke: pinnedDwell, dwellCenter: pinnedDwell, transit: pinned };
    const a = simulate({ seed: SEED, durationTicks: TICKS, timing: cfgA });

    // The package-creation decisions (ids, dests, sizes) come from the operational
    // rng, untouched by timing. Compare the ordered PackageCreated payloads.
    const created = (stream: readonly SimulatedEvent[]): string =>
      JSON.stringify(
        stream.filter((s) => s.event.type === "PackageCreated").map((s) => s.event.payload),
      );

    const b = simulate({
      seed: SEED,
      durationTicks: TICKS,
      timing: {
        dwellSpoke: { median: 99, sigma: 0, min: 99, max: 99 },
        dwellCenter: { median: 99, sigma: 0, min: 99, max: 99 },
        transit: { median: 50, sigma: 0, min: 50, max: 50 },
      },
    });
    // Different timing ⇒ different timestamps, but the SAME packages are created
    // in the SAME order with the SAME payloads (operational rng is unperturbed).
    expect(created(a)).toBe(created(b));
  });
});
