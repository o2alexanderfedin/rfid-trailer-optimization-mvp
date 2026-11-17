import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateBigCityHubs } from "../src/network/hubs.js";
import { hubCoordsChecksum } from "../src/network/routes.js";
import {
  deriveCenterPartition,
  EMPIRICAL_CENTER_COUNT,
  DEFAULT_LEG_CAP_KM,
} from "../src/network/centers.js";

/**
 * T-23-14 — DATASET + PARTITION DRIFT GUARD (plan 23-05).
 *
 * The supply-chain-of-data integrity guard. The committed
 * `us-big-cities.generated.json` (its `hubsChecksum`) and the committed
 * `center-partition.snapshot.json` (its `partitionChecksum` + assignment) are the
 * topology's integrity record. This test RE-DERIVES both from the live code and
 * asserts they match the committed snapshots — so a silent data swap (a changed
 * hub coordinate) or a partition change (a re-route, a different center count, a
 * leg-cap change) becomes a RED test, NOT a silent re-route. Mirrors the
 * road-geometry hub-checksum drift guard (`road-geometry.unit.test.ts`).
 *
 * It ALSO re-asserts the HUB-01/02/03 dataset invariants (count in [80,130],
 * continental envelope, unique ids) so a dataset regeneration that drifts the
 * envelope is caught here too.
 */

// --- read the committed dataset + partition snapshot (the integrity records) ---

interface DatasetFile {
  readonly hubsChecksum: string;
  readonly hubs: readonly { readonly hubId: string }[];
}
interface PartitionSnapshot {
  readonly centerCount: number;
  readonly legCapKm: number;
  readonly hubsChecksum: string;
  readonly partitionChecksum: string;
  readonly antiSpof: boolean;
  readonly centerHubIds: readonly string[];
  readonly backboneLegIds: readonly string[];
  readonly assignment: Readonly<Record<string, string>>;
}

const DATASET = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../src/network/us-big-cities.generated.json", import.meta.url)),
    "utf8",
  ),
) as DatasetFile;

const SNAPSHOT = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../src/network/center-partition.snapshot.json", import.meta.url)),
    "utf8",
  ),
) as PartitionSnapshot;

// Continental-USA envelope (mirrors generate-hubs / hubs.ts).
const CONTINENTAL = { latMin: 24, latMax: 49, lonMin: -125, lonMax: -66 } as const;

describe("dataset drift guard (T-23-14): committed hubsChecksum is reproducible", () => {
  it("hubCoordsChecksum(generateBigCityHubs()) === the committed dataset hubsChecksum", () => {
    expect(hubCoordsChecksum(generateBigCityHubs())).toBe(DATASET.hubsChecksum);
  });

  it("the partition snapshot's hubsChecksum matches the dataset's (same data basis)", () => {
    expect(SNAPSHOT.hubsChecksum).toBe(DATASET.hubsChecksum);
  });

  it("re-deriving the checksum twice is stable (pure, no I/O drift)", () => {
    expect(hubCoordsChecksum(generateBigCityHubs())).toBe(
      hubCoordsChecksum(generateBigCityHubs()),
    );
  });
});

describe("partition drift guard (T-23-14): committed partition is reproducible", () => {
  it("re-deriving the center partition === the committed partitionChecksum", () => {
    const derived = deriveCenterPartition(SNAPSHOT.centerCount, SNAPSHOT.legCapKm);
    expect(derived.partitionChecksum).toBe(SNAPSHOT.partitionChecksum);
  });

  it("the re-derived spoke->center assignment === the committed assignment map", () => {
    const derived = deriveCenterPartition(SNAPSHOT.centerCount, SNAPSHOT.legCapKm);
    const derivedMap = Object.fromEntries(derived.assignment);
    expect(derivedMap).toEqual(SNAPSHOT.assignment);
  });

  it("the re-derived center ids + backbone legs === the committed snapshot", () => {
    const derived = deriveCenterPartition(SNAPSHOT.centerCount, SNAPSHOT.legCapKm);
    expect(derived.centerHubIds).toEqual(SNAPSHOT.centerHubIds);
    expect(derived.backboneLegIds).toEqual(SNAPSHOT.backboneLegIds);
  });

  it("the committed count equals the empirically-chosen EMPIRICAL_CENTER_COUNT", () => {
    expect(SNAPSHOT.centerCount).toBe(EMPIRICAL_CENTER_COUNT);
    expect(SNAPSHOT.legCapKm).toBe(DEFAULT_LEG_CAP_KM);
  });

  it("the partition never collapses to a single primary (centerCount >= 2) and passes anti-SPOF", () => {
    expect(SNAPSHOT.centerCount).toBeGreaterThanOrEqual(2);
    expect(SNAPSHOT.antiSpof).toBe(true);
    const derived = deriveCenterPartition(SNAPSHOT.centerCount, SNAPSHOT.legCapKm);
    expect(derived.antiSpof).toBe(true);
  });

  it("deriveCenterPartition refuses a single primary (count < 2 throws)", () => {
    expect(() => deriveCenterPartition(1)).toThrow();
  });
});

describe("dataset invariants re-guard (HUB-01/02/03)", () => {
  it("hub count is inside the continental envelope [80,130]", () => {
    expect(DATASET.hubs.length).toBeGreaterThanOrEqual(80);
    expect(DATASET.hubs.length).toBeLessThanOrEqual(130);
    expect(generateBigCityHubs().length).toBe(DATASET.hubs.length);
  });

  it("every hub sits inside the continental-USA lat/lon envelope", () => {
    for (const h of generateBigCityHubs()) {
      expect(h.lat).toBeGreaterThanOrEqual(CONTINENTAL.latMin);
      expect(h.lat).toBeLessThanOrEqual(CONTINENTAL.latMax);
      expect(h.lon).toBeGreaterThanOrEqual(CONTINENTAL.lonMin);
      expect(h.lon).toBeLessThanOrEqual(CONTINENTAL.lonMax);
    }
  });

  it("all hub ids are unique", () => {
    const ids = generateBigCityHubs().map((h) => h.hubId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
