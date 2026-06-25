import { describe, expect, it } from "vitest";
import type { PackageInducted, TimingConfig, TrailerDeparted } from "@mm/domain";
import { simulate } from "../src/engine.js";
import { MEMPHIS } from "../src/network/hubs.js";

/**
 * FLOW-01 / FLOW-02 / FLOW-03 — bidirectional freight / consolidation contract.
 *
 * Spoke→center CONSOLIDATION trailers carry real freight drained from the new
 * `pendingAtSpoke` two-queue; the center UNLOADS + RE-STAGES each package into
 * `pendingBySpoke[destSpoke]` (the cross-dock); the optimizer/engine handle both
 * flow directions without double-counting. This suite encodes the observable
 * contract BEFORE plan 21-04 implements `consolidationEnabled` — it is RED on the
 * consolidation assertions until the engine lands, then 21-04 turns it GREEN.
 *
 * Templates mirrored: over-carry.unit.test.ts (the spoke-origin TrailerDeparted
 * where `fromHubId !== CENTER` assertion — the ONLY existing producer of a
 * non-center origin today) + induction-determinism.unit.test.ts (enabling
 * `inductionEnabled: true` to SOURCE spoke freight; off-path byte-identity).
 *
 * NO new RNG salt is introduced — consolidation reuses freight that already
 * exists (induction-origin / center-distribution packages already drawn).
 *
 * Scale bound (GATE-HYGIENE): `durationTicks` ≤ 6000 (the existing determinism
 * horizon — long enough for a spoke round-trip + return leg under SHORT timing).
 */

const CENTER = MEMPHIS.hubId; // center = USA_HUBS[0] = "MEM"
const SEED = 1234;
const TICKS = 6000;

/** SHORT timing so consolidation round-trips (spoke→center→spoke) land inside the horizon. */
const SHORT_TIMING: TimingConfig = {
  transit: { median: 8, sigma: 0.05, min: 1, max: 60 },
  dwellSpoke: { median: 3, sigma: 0.05, min: 1, max: 30 },
  dwellCenter: { median: 4, sigma: 0.05, min: 1, max: 30 },
};

const run = (
  opts: Parameters<typeof simulate>[0],
): ReturnType<typeof simulate> => simulate(opts);

type Departed = TrailerDeparted["payload"];

function departures(stream: ReturnType<typeof simulate>): Departed[] {
  return stream
    .map((s) => s.event)
    .filter((e): e is TrailerDeparted => e.type === "TrailerDeparted")
    .map((e) => e.payload);
}

function inductedByPackageId(
  stream: ReturnType<typeof simulate>,
): Map<string, PackageInducted["payload"]> {
  const out = new Map<string, PackageInducted["payload"]>();
  for (const s of stream) {
    if (s.event.type === "PackageInducted") out.set(s.event.payload.packageId, s.event.payload);
  }
  return out;
}

describe("consolidation freight flow (FLOW-01/02/03)", () => {
  it("FLOW-01: a spoke-origin TrailerDeparted carries NON-EMPTY real freight drained from pendingAtSpoke", () => {
    const stream = run({
      seed: SEED,
      durationTicks: TICKS,
      timing: SHORT_TIMING,
      inductionEnabled: true,
      consolidationEnabled: true,
    });

    // A spoke→center consolidation departure exists carrying real freight (NOT
    // the single-package over-carry case — a non-empty drained manifest).
    const spokeOrigin = departures(stream).filter((d) => d.fromHubId !== CENTER);
    const withFreight = spokeOrigin.filter((d) => d.packageIds.length > 0);
    expect(
      withFreight.length,
      "expected ≥1 spoke-origin TrailerDeparted with a NON-EMPTY consolidation manifest",
    ).toBeGreaterThan(0);
  });

  it("FLOW-01: no package is double-drained (no packageId appears in two spoke-origin manifests)", () => {
    const stream = run({
      seed: SEED,
      durationTicks: TICKS,
      timing: SHORT_TIMING,
      inductionEnabled: true,
      consolidationEnabled: true,
    });

    const spokeOrigin = departures(stream).filter((d) => d.fromHubId !== CENTER);
    const seen = new Set<string>();
    for (const d of spokeOrigin) {
      for (const pid of d.packageIds) {
        expect(
          seen.has(pid),
          `package ${pid} appears in two distinct spoke-origin manifests (double-drain)`,
        ).toBe(false);
        seen.add(pid);
      }
    }
    // The guard is only meaningful if consolidation actually moved freight.
    expect(seen.size, "expected consolidation to drain at least one package").toBeGreaterThan(0);
  });

  it("FLOW-02: a package consolidated Spoke A→center is later re-staged + departs center→destSpoke (cross-dock)", () => {
    const stream = run({
      seed: SEED,
      durationTicks: TICKS,
      timing: SHORT_TIMING,
      inductionEnabled: true,
      consolidationEnabled: true,
    });

    const inducted = inductedByPackageId(stream);
    const deps = departures(stream);
    const spokeOrigin = deps.filter((d) => d.fromHubId !== CENTER && d.packageIds.length > 0);

    // Pick a package that departed a spoke toward the center on a consolidation leg.
    let crossDocked = false;
    for (const consolidation of spokeOrigin) {
      for (const pid of consolidation.packageIds) {
        const meta = inducted.get(pid);
        if (meta === undefined) continue;
        // After cross-dock at the center, the package departs center→its destHub.
        const distributed = deps.some(
          (d) =>
            d.fromHubId === CENTER &&
            d.toHubId === meta.destHubId &&
            d.packageIds.includes(pid),
        );
        if (distributed) {
          crossDocked = true;
          break;
        }
      }
      if (crossDocked) break;
    }
    expect(
      crossDocked,
      "expected a consolidated package to be re-staged at the center and depart center→destSpoke",
    ).toBe(true);
  });

  it("FLOW-03: an empty spoke→center return leg (empty pendingAtSpoke) departs without error", () => {
    // The run completing without a throw is the contract: a consolidation trailer
    // departing a spoke whose pendingAtSpoke is empty produces an empty-manifest
    // spoke-origin departure — a VALID empty return, not an error.
    expect(() =>
      run({
        seed: SEED,
        durationTicks: TICKS,
        timing: SHORT_TIMING,
        inductionEnabled: true,
        consolidationEnabled: true,
      }),
    ).not.toThrow();

    const stream = run({
      seed: SEED,
      durationTicks: TICKS,
      timing: SHORT_TIMING,
      inductionEnabled: true,
      consolidationEnabled: true,
    });
    const spokeOrigin = departures(stream).filter((d) => d.fromHubId !== CENTER);
    const empty = spokeOrigin.filter((d) => d.packageIds.length === 0);
    expect(
      empty.length,
      "expected ≥1 spoke→center empty-manifest return leg (valid empty return)",
    ).toBeGreaterThan(0);
  });
});
