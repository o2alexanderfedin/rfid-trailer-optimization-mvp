import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";
import {
  emptyTagRegistryState,
  type OccurredEvent,
  resolveTag,
  type TagRegistryState,
  tagRegistryReducer,
} from "../src/index.js";

/**
 * Task 1 (RED -> GREEN), SNS-02: the tag -> package REGISTRY reducer.
 *
 * The registry is a PURE fold of `PackageCreated.rfidTagId` into a
 * `tagId -> packageId` map: it turns the raw `tagId` an `RfidObserved` carries
 * into the `packageId` the RFID evidence is ABOUT. The discipline mirrors the
 * other operational reducers: no wall clock, no RNG, exhaustive over the closed
 * 11-member `DomainEvent` union, and a no-op for the 10 non-registry events.
 *
 * Anti-spoofing (T-03-13): an UNMAPPED tagId resolves to `undefined` — it is not
 * a package — never an exception. The caller logs it and moves on.
 */

const T0 = Date.parse("2026-05-01T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function evt(event: DomainEvent, occurredAt: string): OccurredEvent {
  return { event, occurredAt };
}

function pkgCreated(
  packageId: string,
  origin: string,
  dest: string,
  rfidTagId?: string,
): DomainEvent {
  return {
    type: "PackageCreated",
    schemaVersion: 1,
    payload: {
      packageId,
      originHubId: origin,
      destHubId: dest,
      sizeClass: "medium",
      weight: 10,
      ...(rfidTagId === undefined ? {} : { rfidTagId }),
    },
  };
}

function rfidObserved(
  tagId: string,
  readerId: string,
  trailerId: string,
  hubId: string,
): DomainEvent {
  return {
    type: "RfidObserved",
    schemaVersion: 1,
    payload: {
      tagId,
      readerId,
      antennaId: "ANT-1",
      rssi: -55,
      trailerId,
      hubId,
      confidence: 0.8,
    },
  };
}

function fold(events: OccurredEvent[]): TagRegistryState {
  return events.reduce(tagRegistryReducer, emptyTagRegistryState);
}

describe("tagRegistryReducer (SNS-02)", () => {
  it("maps a PackageCreated.rfidTagId -> packageId so a tagId resolves to a package", () => {
    const state = fold([
      evt(pkgCreated("PKG-1", "MEM", "LAX", "TAG-1"), at(0)),
      evt(pkgCreated("PKG-2", "MEM", "DFW", "TAG-2"), at(1000)),
    ]);
    expect(resolveTag(state, "TAG-1")).toBe("PKG-1");
    expect(resolveTag(state, "TAG-2")).toBe("PKG-2");
    expect(state.size).toBe(2);
  });

  it("resolves an RfidObserved.tagId back to its package (the SNS-02 round trip)", () => {
    const state = fold([evt(pkgCreated("PKG-9", "MEM", "LAX", "TAG-9"), at(0))]);
    const observed = rfidObserved("TAG-9", "READER-1", "TRL-1", "MEM");
    // The observed tagId is the same id the registry keys on.
    expect(observed.type).toBe("RfidObserved");
    if (observed.type === "RfidObserved") {
      expect(resolveTag(state, observed.payload.tagId)).toBe("PKG-9");
    }
  });

  it("PackageCreated WITHOUT rfidTagId adds no entry (no-op)", () => {
    const state = fold([
      evt(pkgCreated("PKG-NO-TAG", "MEM", "LAX"), at(0)),
      evt(pkgCreated("PKG-WITH", "MEM", "LAX", "TAG-W"), at(1000)),
    ]);
    expect(state.size).toBe(1);
    expect(resolveTag(state, "TAG-W")).toBe("PKG-WITH");
  });

  it("an UNMAPPED tagId resolves to undefined (T-03-13: not a package, not an error)", () => {
    const state = fold([evt(pkgCreated("PKG-1", "MEM", "LAX", "TAG-1"), at(0))]);
    expect(resolveTag(state, "UNKNOWN-TAG")).toBeUndefined();
    expect(resolveTag(emptyTagRegistryState, "ANY")).toBeUndefined();
  });

  it("the 10 non-PackageCreated events are no-ops (registry unchanged, same reference for the map)", () => {
    const base = fold([evt(pkgCreated("PKG-1", "MEM", "LAX", "TAG-1"), at(0))]);
    const after = tagRegistryReducer(
      base,
      evt(rfidObserved("TAG-1", "READER-1", "TRL-1", "MEM"), at(1000)),
    );
    // No-op: an irrelevant event neither adds nor removes mappings.
    expect(after).toBe(base);
    expect(after.size).toBe(1);
  });

  it("is PURE: identical event sequences produce deep-equal state; re-folding is identical", () => {
    const events = [
      evt(pkgCreated("PKG-1", "MEM", "LAX", "TAG-1"), at(0)),
      evt(pkgCreated("PKG-2", "DFW", "LAX", "TAG-2"), at(2000)),
      evt(rfidObserved("TAG-1", "R1", "TRL-1", "MEM"), at(3000)),
    ];
    const a = fold(events);
    const b = fold(events);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });

  it("a later PackageCreated re-binding a tag overwrites the mapping (last write wins, deterministic)", () => {
    const state = fold([
      evt(pkgCreated("PKG-OLD", "MEM", "LAX", "TAG-X"), at(0)),
      evt(pkgCreated("PKG-NEW", "MEM", "LAX", "TAG-X"), at(1000)),
    ]);
    expect(resolveTag(state, "TAG-X")).toBe("PKG-NEW");
    expect(state.size).toBe(1);
  });
});
