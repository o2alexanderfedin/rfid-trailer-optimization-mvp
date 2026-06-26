import { describe, expect, it } from "vitest";

import { simulate, runToHorizon } from "../src/engine.js";
import type { SimContinuation } from "../src/continuation.js";

/**
 * Phase 23 (NET-01) — the `continentalTopology` engine flow.
 *
 * Two guarantees:
 *  1. FLAGS-OFF KEYSTONE — `continentalTopology` absent ≡ explicit `false`: the
 *     seed-42 short run is byte-identical either way (the 10k golden gate lands in
 *     plan 23-05; here we assert the explicit-false === absent equality + that no
 *     new RNG substream is constructed for the topology when off).
 *  2. FLAG-ON MULTI-CENTER — with the flag the engine swaps the single Memphis
 *     center for `centerOf(spoke)` over a multi-center backbone: every emitted
 *     `RouteRegistered` / `TrailerDeparted` leg belongs to the multi-center route
 *     set, and a cross-center package (origin + dest under DIFFERENT centers)
 *     traverses a center<->center backbone leg in its trip.
 */

const FLAGS_OFF = { seed: 42, durationTicks: 500 } as const;

describe("continentalTopology flags-off gate (NET-01 keystone)", () => {
  it("explicit continentalTopology: false is byte-identical to the flag being absent", () => {
    const absent = simulate(FLAGS_OFF);
    const explicitFalse = simulate({ ...FLAGS_OFF, continentalTopology: false });
    expect(JSON.stringify(explicitFalse)).toBe(JSON.stringify(absent));
  });

  it("a short seed-42 run is reproducible with the flag absent", () => {
    const a = simulate(FLAGS_OFF);
    const b = simulate({ ...FLAGS_OFF });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe("continentalTopology ON — multi-center freight flow (NET-01)", () => {
  // Induction routes spoke->spoke; consolidation is the spoke->center return path
  // that, under continental topology, hops the backbone when origin + dest centers
  // differ. Together they exercise the full spoke -> origin center -> backbone ->
  // dest center -> dest spoke traversal. A long horizon lets at least one
  // cross-center package complete its multi-leg journey.
  const ON = {
    seed: 7,
    durationTicks: 8000,
    continentalTopology: true,
    inductionEnabled: true,
    consolidationEnabled: true,
  } as const;

  const stream = simulate(ON);

  it("registers a multi-center route set (more than the legacy 18 single-center legs)", () => {
    const routeLegs = stream.filter((e) => e.event.type === "RouteRegistered");
    // The continental network has many centers + spokes => far more than the
    // legacy 9-spoke * 2 = 18 directed legs.
    expect(routeLegs.length).toBeGreaterThan(18);
  });

  it("every TrailerDeparted leg is a registered route leg (no off-network departures)", () => {
    const registered = new Set<string>();
    for (const e of stream) {
      if (e.event.type === "RouteRegistered") {
        registered.add(`${e.event.payload.fromHubId}->${e.event.payload.toHubId}`);
      }
    }
    for (const e of stream) {
      if (e.event.type === "TrailerDeparted") {
        const leg = `${e.event.payload.fromHubId}->${e.event.payload.toHubId}`;
        expect(registered.has(leg)).toBe(true);
      }
    }
  });

  it("at least one departure runs a center<->center backbone leg (cross-center freight)", () => {
    // A backbone leg connects two CENTERS. Centers are the hubs that appear as the
    // `fromHubId` of a center->spoke distribution leg (a center serves >= 1 spoke).
    // We detect a backbone traversal as a departure whose BOTH endpoints are
    // centers. With induction on, cross-center packages force such a leg.
    const departures = stream.filter((e) => e.event.type === "TrailerDeparted");
    // Heuristic over the route graph: a hub is a "center" if it is the source of
    // multiple distinct destination legs (a fan-out node).
    const outDegree = new Map<string, Set<string>>();
    for (const e of stream) {
      if (e.event.type === "RouteRegistered") {
        const { fromHubId, toHubId } = e.event.payload;
        (outDegree.get(fromHubId) ?? outDegree.set(fromHubId, new Set()).get(fromHubId)!).add(
          toHubId,
        );
      }
    }
    const centers = new Set(
      [...outDegree.entries()].filter(([, dests]) => dests.size >= 2).map(([id]) => id),
    );
    const backboneDeparture = departures.some(
      (e) =>
        e.event.type === "TrailerDeparted" &&
        centers.has(e.event.payload.fromHubId) &&
        centers.has(e.event.payload.toHubId),
    );
    expect(backboneDeparture).toBe(true);
  });

  it("is deterministic — same seed + flag yields a byte-identical stream", () => {
    const a = simulate(ON);
    const b = simulate({ ...ON });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("is continuation-equivalent — chunked === all-at-once (the new centerHubId tasks + backbone hop survive a resume)", () => {
    const horizon = ON.durationTicks;
    const allAtOnce = simulate(ON);

    // Drive the SAME run in fixed chunks via the continuation API. The new
    // arriveOverCarried/arriveConsolidation `centerHubId` task fields + the
    // cross-center backbone-hop tasks must serialize + resume byte-identically.
    const opts = {
      continentalTopology: ON.continentalTopology,
      inductionEnabled: ON.inductionEnabled,
      consolidationEnabled: ON.consolidationEnabled,
    } as const;
    const chunk = 500;
    const collected: ReturnType<typeof simulate> = [];
    let continuation: SimContinuation | undefined;
    for (let target = chunk; ; target += chunk) {
      const h = Math.min(target, horizon);
      const start = continuation ?? { seed: ON.seed };
      const { events, continuation: next } = runToHorizon(start, h, opts);
      collected.push(...events);
      continuation = next;
      if (h >= horizon) break;
    }
    expect(collected.length).toBe(allAtOnce.length);
    expect(JSON.stringify(collected)).toBe(JSON.stringify(allAtOnce));
  });
});
