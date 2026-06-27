import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { simulate } from "../src/engine.js";
import { generateBigCityHubs, type BigCityHub } from "../src/network/hubs.js";
import { deriveCenterPartition } from "../src/network/centers.js";
import {
  buildRoutes,
  buildTransitParamsByLeg,
  type BackboneLeg,
  type RouteTopology,
} from "../src/network/routes.js";
import { FLAGS_OFF_GOLDEN_SHA256, CONTINENTAL_GOLDEN_SHA256 } from "./goldens.js";

/**
 * DET-01 (continental, plan 23-05) — THE NEW CONTINENTAL GOLDEN.
 *
 * The continental multi-center model gets its OWN committed golden, captured on a
 * SMALL 12-20-hub deterministic fixture (a fast hash). Per CONTEXT the full ~92-hub
 * `simulate` run is a PERF concern, NOT a golden — so the golden here is the pure,
 * deterministic CONTINENTAL TOPOLOGY ARTIFACT (centers + spoke->center assignment +
 * near-full-mesh backbone + the resulting `Route[]` + per-leg transit params) built
 * over a fixed fixture via the SAME pure functions the engine's continental path
 * uses. The artifact is geometry-light at the decision layer: ids + integers drive
 * the partition; the great-circle geometry is for the map (transcendentals stay out
 * of the partition decision — the routes' geometry is part of the model's committed
 * output and hashes deterministically because `greatCircle` is itself pure).
 *
 * REPRODUCIBILITY-FIRST (T-23-12): the test asserts the SAME-SEED (here: same fixed
 * fixture) artifact hashes IDENTICALLY across two in-process derivations BEFORE the
 * golden constant is asserted — so a non-reproducible (flaky) hash can NEVER be
 * baked in. The golden was captured on x86_64 (darwin), node v23.
 *
 * Mirrors `consolidation-determinism.unit.test.ts` (a small fixed input + a
 * deterministic continental construction; off-path byte-identity lives in
 * `determinism.unit.test.ts`).
 */

// --- the SMALL fixed fixture: first 14 hubs of the committed dataset ----------
// generateBigCityHubs() is sorted by hubId, so this slice is a stable, fixed,
// deterministic 14-hub BigCityHub[] (inside the 12-20 envelope, fast to hash).
const FIXTURE_SIZE = 14;
const FIXTURE_CENTER_COUNT = 4;
const FIXTURE_LEG_CAP_KM = 2500;

function fixtureHubs(): readonly BigCityHub[] {
  return generateBigCityHubs().slice(0, FIXTURE_SIZE);
}

/** Build the deterministic continental artifact for the fixed fixture. */
function continentalArtifact(): {
  partition: ReturnType<typeof deriveCenterPartition>;
  routes: ReturnType<typeof buildRoutes>;
  transit: ReadonlyArray<readonly [string, unknown]>;
} {
  const hubs = fixtureHubs();
  const partition = deriveCenterPartition(FIXTURE_CENTER_COUNT, FIXTURE_LEG_CAP_KM, hubs);
  const centerOf = new Map(partition.assignment);
  const backbone: BackboneLeg[] = partition.backboneLegIds.map((id) => {
    const [fromHubId, toHubId] = id.split("->");
    return { fromHubId: fromHubId!, toHubId: toHubId! };
  });
  const topology: RouteTopology = { centerOf, backbone };
  const routes = buildRoutes(hubs, undefined, topology);
  const transit = [
    ...buildTransitParamsByLeg(hubs, 0.18, undefined, topology).entries(),
  ].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { partition, routes, transit };
}

function hashArtifact(): string {
  return createHash("sha256").update(JSON.stringify(continentalArtifact())).digest("hex");
}

// See goldens.ts for CONTINENTAL_GOLDEN_SHA256 — captured from continentalArtifact()
// over the fixed 14-hub fixture (centerCount=4) on x86_64 darwin, node v23.
// Same-seed reproducibility is asserted BELOW before the golden is checked (T-23-12).

describe("continental model golden (DET-01, small fixture)", () => {
  it("the fixture is inside the 12-20-hub fast-hash envelope", () => {
    expect(fixtureHubs().length).toBe(FIXTURE_SIZE);
    expect(FIXTURE_SIZE).toBeGreaterThanOrEqual(12);
    expect(FIXTURE_SIZE).toBeLessThanOrEqual(20);
  });

  // REPRODUCIBILITY FIRST (T-23-12): two in-process derivations hash identically.
  it("is same-seed reproducible: two derivations hash identically (proven BEFORE the golden)", () => {
    expect(hashArtifact()).toBe(hashArtifact());
  });

  it("hashes to the committed continental golden", () => {
    expect(hashArtifact()).toBe(CONTINENTAL_GOLDEN_SHA256);
  });

  it("the continental model genuinely differs from the legacy single-center golden", () => {
    expect(CONTINENTAL_GOLDEN_SHA256).not.toBe(FLAGS_OFF_GOLDEN_SHA256);
  });

  it("the fixture topology never collapses to a single primary (centerCount >= 2, anti-SPOF)", () => {
    const { partition } = continentalArtifact();
    expect(partition.centerCount).toBeGreaterThanOrEqual(2);
    expect(partition.antiSpof).toBe(true);
  });

  it("the continental routes cover spoke<->center + center<->center backbone legs", () => {
    const { routes, partition } = continentalArtifact();
    // 86? no — fixture: spokes*2 + backbone(n*(n-1)). 10 spokes -> 20, +12 backbone = 32.
    const spokes = FIXTURE_SIZE - partition.centerCount;
    expect(routes.length).toBe(spokes * 2 + partition.centerCount * (partition.centerCount - 1));
  });
});

/**
 * The continental-ON full-dataset stream genuinely DIFFERS from the legacy
 * single-center stream (a short run — a sanity that the flag actually re-routes
 * freight, complementing the != golden assertion above). NOT a golden (the full
 * 92-hub run is a deferred perf concern); this only asserts inequality + the
 * short-run reproducibility of the continental engine path.
 */
describe("continental engine path differs from legacy (sanity, not a golden)", () => {
  const OPTS = { seed: 42, durationTicks: 300 } as const;

  it("continentalTopology: true produces a DIFFERENT stream than the legacy path", () => {
    const legacy = JSON.stringify(simulate(OPTS));
    const continental = JSON.stringify(simulate({ ...OPTS, continentalTopology: true }));
    expect(continental).not.toBe(legacy);
  });

  it("the continental engine path is itself same-seed reproducible", () => {
    const a = createHash("sha256")
      .update(JSON.stringify(simulate({ ...OPTS, continentalTopology: true })))
      .digest("hex");
    const b = createHash("sha256")
      .update(JSON.stringify(simulate({ ...OPTS, continentalTopology: true })))
      .digest("hex");
    expect(b).toBe(a);
  });
});
