import { describe, expect, it } from "vitest";
import { DEFAULT_TIMING_CONFIG, expectedMinutes, type LogNormalParams } from "@mm/domain";
import { USA_HUBS } from "../src/network/hubs.js";
import {
  buildTransitParamsByLeg,
  haversineKm,
  routeId,
  transitParamsForLeg,
} from "../src/network/routes.js";
import { simulate, type SimulatedEvent } from "../src/engine.js";

/**
 * TIME-01 — per-leg transit MEDIAN derived from REAL geography.
 *
 * The flat ~30-min global transit median is replaced by a per-directed-leg
 * median computed from the great-circle (haversine) distance between the leg's
 * two hubs at an 80 km/h average HGV speed (`distanceKm / 80 * 60` minutes). The
 * derivation is a PURE function of hub coordinates — no clock, no RNG — so the
 * resulting medians are byte-reproducible. (No ORS key is available here; once
 * VIZ-06's road-geometry.generated.json exists the median swaps to ORS
 * `summary.duration`. See `routes.ts`.)
 */

const EPOCH = Date.parse("2026-04-01T00:00:00.000Z");
const MS_PER_TICK = 60_000;
const tick = (iso: string): number => Math.round((Date.parse(iso) - EPOCH) / MS_PER_TICK);

const hub = (id: string) => {
  const h = USA_HUBS.find((x) => x.hubId === id);
  if (h === undefined) throw new Error(`no hub ${id}`);
  return h;
};

const MEM = hub("MEM");
const SEA = hub("SEA"); // longest spoke leg from Memphis (~3000 km)
const ATL = hub("ATL"); // shortest spoke leg from Memphis (~540 km)

describe("haversineKm (pure great-circle distance)", () => {
  it("is symmetric and positive for distinct hubs", () => {
    const ab = haversineKm(MEM, SEA);
    const ba = haversineKm(SEA, MEM);
    expect(ab).toBeGreaterThan(0);
    expect(ab).toBeCloseTo(ba, 6); // symmetric
  });

  it("is zero for coincident points and pure (same inputs ⇒ same output)", () => {
    expect(haversineKm(MEM, MEM)).toBeCloseTo(0, 6);
    expect(haversineKm(MEM, SEA)).toBe(haversineKm(MEM, SEA));
  });

  it("matches a known-good Memphis→Seattle great-circle distance (~3000 km)", () => {
    expect(haversineKm(MEM, SEA)).toBeGreaterThan(2900);
    expect(haversineKm(MEM, SEA)).toBeLessThan(3100);
  });
});

describe("transitParamsForLeg (geography-derived LogNormalParams)", () => {
  const sigma = DEFAULT_TIMING_CONFIG.transit.sigma;

  it("median = haversineKm / 80 * 60 (80 km/h HGV)", () => {
    const p = transitParamsForLeg(MEM, SEA, sigma);
    expect(p.median).toBeCloseTo((haversineKm(MEM, SEA) / 80) * 60, 6);
    expect(p.sigma).toBe(sigma);
  });

  it("a LONG leg has a strictly larger median than a SHORT leg", () => {
    const long = transitParamsForLeg(MEM, SEA, sigma);
    const short = transitParamsForLeg(MEM, ATL, sigma);
    expect(long.median).toBeGreaterThan(short.median);
  });

  it("derives the clamp band from the median: min=max(5,round(median*0.4)), max=round(median*3)", () => {
    const p = transitParamsForLeg(MEM, SEA, sigma);
    expect(p.min).toBe(Math.max(5, Math.round(p.median * 0.4)));
    expect(p.max).toBe(Math.round(p.median * 3));
    expect(p.min).toBeLessThan(p.max);
  });

  it("is pure: medians are a function of coordinates only", () => {
    const a = transitParamsForLeg(MEM, SEA, sigma);
    const b = transitParamsForLeg(MEM, SEA, sigma);
    expect(a).toEqual(b);
  });
});

describe("buildTransitParamsByLeg (per directed leg)", () => {
  it("produces a directed entry per hub-and-spoke leg, keyed by routeId", () => {
    const sigma = DEFAULT_TIMING_CONFIG.transit.sigma;
    const byLeg = buildTransitParamsByLeg(USA_HUBS, sigma);
    // 9 spokes × 2 directions = 18 directed legs.
    expect(byLeg.size).toBe((USA_HUBS.length - 1) * 2);
    const out = byLeg.get(routeId("MEM", "SEA"));
    const back = byLeg.get(routeId("SEA", "MEM"));
    expect(out).toBeDefined();
    expect(back).toBeDefined();
    // Directed legs over the same pair share the (symmetric) median.
    expect(out!.median).toBeCloseTo(back!.median, 6);
    expect(out!.median).toBeCloseTo((haversineKm(MEM, SEA) / 80) * 60, 6);
  });
});

/** Recover per-leg transit ticks tagged with the leg's directed routeId. */
interface LegTransit {
  readonly routeKey: string;
  readonly ticks: number;
}
function transitsByLeg(stream: readonly SimulatedEvent[]): LegTransit[] {
  const depart = new Map<string, { tick: number; from: string; to: string }>();
  const out: LegTransit[] = [];
  for (const s of stream) {
    if (s.event.type === "TrailerDeparted") {
      depart.set(s.event.payload.tripId, {
        tick: tick(s.occurredAt),
        from: s.event.payload.fromHubId,
        to: s.event.payload.toHubId,
      });
    } else if (s.event.type === "TrailerArrivedAtHub") {
      const d = depart.get(s.event.payload.tripId);
      if (d !== undefined) out.push({ routeKey: routeId(d.from, d.to), ticks: tick(s.occurredAt) - d.tick });
    }
  }
  return out;
}

describe("engine wires per-leg transit (TIME-01)", () => {
  // A long horizon so even the longest coast legs complete at least one transit.
  const SEED = 4242;
  const TICKS = 8000;

  it("the long MEM→SEA leg realizes a strictly larger transit than the short MEM→ATL leg", () => {
    const stream = simulate({ seed: SEED, durationTicks: TICKS });
    const legs = transitsByLeg(stream);
    const seaOut = legs.filter((l) => l.routeKey === routeId("MEM", "SEA")).map((l) => l.ticks);
    const atlOut = legs.filter((l) => l.routeKey === routeId("MEM", "ATL")).map((l) => l.ticks);
    expect(seaOut.length).toBeGreaterThan(0);
    expect(atlOut.length).toBeGreaterThan(0);
    // Every realized SEA transit dwarfs every realized ATL transit (the medians
    // differ by ~5×; the log-normal spread cannot bridge that gap).
    expect(Math.min(...seaOut)).toBeGreaterThan(Math.max(...atlOut));
  });

  it("each realized transit lands within its OWN geography-derived clamp band", () => {
    const sigma = DEFAULT_TIMING_CONFIG.transit.sigma;
    const byLeg = buildTransitParamsByLeg(USA_HUBS, sigma);
    const stream = simulate({ seed: SEED, durationTicks: TICKS });
    const legs = transitsByLeg(stream);
    expect(legs.length).toBeGreaterThan(0);
    for (const { routeKey, ticks } of legs) {
      const p = byLeg.get(routeKey);
      expect(p, `expected per-leg params for ${routeKey}`).toBeDefined();
      // The engine rounds the sampled minutes to whole ticks (≥1), so the
      // realized value sits within [min, max] (the sampler clamp), floored at 1.
      const lo = Math.max(1, (p as LogNormalParams).min);
      expect(ticks).toBeGreaterThanOrEqual(lo);
      expect(ticks).toBeLessThanOrEqual((p as LogNormalParams).max);
    }
  });

  it("the realized transit clusters around the per-leg expectedMinutes (mean)", () => {
    const sigma = DEFAULT_TIMING_CONFIG.transit.sigma;
    const byLeg = buildTransitParamsByLeg(USA_HUBS, sigma);
    const stream = simulate({ seed: SEED, durationTicks: TICKS });
    const seaOut = transitsByLeg(stream)
      .filter((l) => l.routeKey === routeId("MEM", "SEA"))
      .map((l) => l.ticks);
    expect(seaOut.length).toBeGreaterThan(0);
    const mean = expectedMinutes(byLeg.get(routeId("MEM", "SEA"))!);
    // Realized SEA transit is within a factor of 2 of the distribution mean.
    for (const v of seaOut) {
      expect(v).toBeGreaterThan(mean / 2);
      expect(v).toBeLessThan(mean * 2);
    }
  });

  it("same seed ⇒ byte-identical stream (per-leg transit draws stay deterministic)", () => {
    const a = simulate({ seed: SEED, durationTicks: 2000 });
    const b = simulate({ seed: SEED, durationTicks: 2000 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
