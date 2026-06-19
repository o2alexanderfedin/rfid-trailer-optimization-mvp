import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";
import { DEFAULT_FUSION_CONFIG, type FusionConfig } from "@mm/sensor-fusion";
import {
  emptyTagRegistryState,
  emptyZoneEstimateState,
  makeZoneEstimateReducer,
  type OccurredEvent,
  type TagRegistryState,
  tagRegistryReducer,
  zoneEstimateKey,
  type ZoneEstimateState,
} from "../src/index.js";

/**
 * Task 1 (RED -> GREEN), SNS-02 / SNS-03 (consumed): the ZONE-ESTIMATE reducer.
 *
 * It folds `RfidObserved` reads — resolved tagId -> packageId via the tag
 * registry — through the Plan-02 fusion engine (`windowObservations` + `fuseZone`,
 * anti-P5b) into the LATEST confidence-scored `ZoneEstimate` per
 * `(packageId, trailerId)`.
 *
 * Anti-P5b is INHERITED: the persisted confidence is STRICTLY < 1.0 (and <=
 * `confidenceCeiling`) no matter how many identical same-dwell reads arrive,
 * because the windowing collapses a burst to ONE observation and the fusion
 * cap + entropy floor bound the posterior.
 *
 * Purity (P3): the reducer is pure; time comes only from `occurredAt`; the
 * registry + config are injected (a closure), so identical events + deps yield
 * identical state, byte-for-byte (FND-04 discipline).
 */

const T0 = Date.parse("2026-05-01T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function evt(event: DomainEvent, occurredAt: string): OccurredEvent {
  return { event, occurredAt };
}

function pkgCreated(packageId: string, rfidTagId: string): DomainEvent {
  return {
    type: "PackageCreated",
    schemaVersion: 1,
    payload: {
      packageId,
      originHubId: "MEM",
      destHubId: "LAX",
      sizeClass: "medium",
      weight: 10,
      rfidTagId,
    },
  };
}

function rfid(
  tagId: string,
  readerId: string,
  trailerId: string,
  hubId: string,
  rssi: number,
): DomainEvent {
  return {
    type: "RfidObserved",
    schemaVersion: 1,
    payload: { tagId, readerId, antennaId: "ANT-1", rssi, trailerId, hubId, confidence: 0.8 },
  };
}

/** A config that maps READER-REAR -> rear evidence, so reads move the posterior. */
const CONFIG: FusionConfig = {
  ...DEFAULT_FUSION_CONFIG,
  readerZoneEvidence: { "READER-REAR": "rear", "READER-NOSE": "nose" },
};

function registryWith(...tags: Array<[packageId: string, tagId: string]>): TagRegistryState {
  return tags.reduce(
    (state, [packageId, tagId]) =>
      tagRegistryReducer(state, evt(pkgCreated(packageId, tagId), at(0))),
    emptyTagRegistryState,
  );
}

function foldZones(
  registry: TagRegistryState,
  events: OccurredEvent[],
  config: FusionConfig = CONFIG,
): ZoneEstimateState {
  const reduce = makeZoneEstimateReducer({
    resolveTag: (tagId) => registry.get(tagId),
    config,
  });
  return events.reduce(reduce, emptyZoneEstimateState);
}

describe("zoneEstimateReducer (SNS-02 attribution + fused ZoneEstimate)", () => {
  it("holds the latest fused estimate per (packageId, trailerId)", () => {
    const registry = registryWith(["PKG-1", "TAG-1"]);
    const state = foldZones(registry, [
      evt(rfid("TAG-1", "READER-REAR", "TRL-1", "MEM", -50), at(0)),
    ]);
    const est = state.get(zoneEstimateKey("PKG-1", "TRL-1"));
    expect(est).toBeDefined();
    expect(est?.packageId).toBe("PKG-1");
    expect(est?.trailerId).toBe("TRL-1");
    expect(est?.estimatedZone).toBe("rear");
  });

  it("persisted confidence is STRICTLY < 1.0 and <= the fusion ceiling (anti-P5b)", () => {
    const registry = registryWith(["PKG-1", "TAG-1"]);
    // A burst of 200 identical strong same-dwell reads collapses to ONE window.
    const events: OccurredEvent[] = [];
    for (let i = 0; i < 200; i += 1) {
      // Same coarse dwell window (all within ~1s) and same reader/tag/trailer.
      events.push(evt(rfid("TAG-1", "READER-REAR", "TRL-1", "MEM", -45), at(i * 5)));
    }
    const state = foldZones(registry, events);
    const est = state.get(zoneEstimateKey("PKG-1", "TRL-1"));
    expect(est).toBeDefined();
    expect(est!.confidence).toBeLessThan(1.0);
    expect(est!.confidence).toBeLessThanOrEqual(CONFIG.confidenceCeiling);
  });

  it("an UNMAPPED tag is ignored (no estimate, never an exception) — T-03-13", () => {
    const registry = registryWith(["PKG-1", "TAG-1"]);
    const state = foldZones(registry, [
      evt(rfid("UNKNOWN-TAG", "READER-REAR", "TRL-9", "MEM", -50), at(0)),
    ]);
    expect(state.size).toBe(0);
  });

  it("keys separately per trailer: the same package in two trailers yields two estimates", () => {
    const registry = registryWith(["PKG-1", "TAG-1"]);
    const state = foldZones(registry, [
      evt(rfid("TAG-1", "READER-REAR", "TRL-A", "MEM", -50), at(0)),
      evt(rfid("TAG-1", "READER-NOSE", "TRL-B", "MEM", -50), at(60_000)),
    ]);
    expect(state.size).toBe(2);
    expect(state.get(zoneEstimateKey("PKG-1", "TRL-A"))?.estimatedZone).toBe("rear");
    expect(state.get(zoneEstimateKey("PKG-1", "TRL-B"))?.estimatedZone).toBe("nose");
  });

  it("the 10 non-RfidObserved events are no-ops (same reference, unchanged)", () => {
    const registry = registryWith(["PKG-1", "TAG-1"]);
    const base = foldZones(registry, [
      evt(rfid("TAG-1", "READER-REAR", "TRL-1", "MEM", -50), at(0)),
    ]);
    const reduce = makeZoneEstimateReducer({
      resolveTag: (tagId) => registry.get(tagId),
      config: CONFIG,
    });
    const after = reduce(base, evt(pkgCreated("PKG-2", "TAG-2"), at(1000)));
    expect(after).toBe(base);
  });

  it("is PURE: same registry + events + config yield deep-equal state", () => {
    const registry = registryWith(["PKG-1", "TAG-1"], ["PKG-2", "TAG-2"]);
    const events = [
      evt(rfid("TAG-1", "READER-REAR", "TRL-1", "MEM", -50), at(0)),
      evt(rfid("TAG-2", "READER-NOSE", "TRL-2", "DFW", -48), at(70_000)),
    ];
    const a = foldZones(registry, events);
    const b = foldZones(registry, events);
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    for (const k of a.keys()) {
      expect(a.get(k)).toEqual(b.get(k));
    }
  });

  it("freshness advances: lastObservedAt reflects the latest read in the group", () => {
    const registry = registryWith(["PKG-1", "TAG-1"]);
    const state = foldZones(registry, [
      evt(rfid("TAG-1", "READER-REAR", "TRL-1", "MEM", -50), at(0)),
      evt(rfid("TAG-1", "READER-REAR", "TRL-1", "MEM", -50), at(120_000)),
    ]);
    const est = state.get(zoneEstimateKey("PKG-1", "TRL-1"));
    expect(est?.lastObservedAt).toBe(at(120_000));
  });
});
