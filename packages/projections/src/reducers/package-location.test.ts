import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";
import {
  type PackageLocationState,
  emptyPackageLocationState,
  packageLocationReducer,
} from "./package-location.js";
import type { OccurredEvent } from "./reducer.js";

/**
 * Plan 22-04 (OUT-04 / D-22-1): package-location `PackageDelivered` hard-DELETE
 * purge. The delivered package's row is removed via `Map.delete()`, which is a
 * natural no-op on a missing key (never throws) — so the reducer is idempotent
 * and crash-safe on re-apply/replay.
 */

function evt(event: DomainEvent, occurredAt: string): OccurredEvent {
  return { event, occurredAt };
}

function arrived(packageId: string, hubId: string): DomainEvent {
  return {
    type: "PackageArrivedAtHub",
    schemaVersion: 1,
    payload: { packageId, hubId },
  };
}

function delivered(packageId: string, hubId: string): DomainEvent {
  return {
    type: "PackageDelivered",
    schemaVersion: 1,
    payload: {
      packageId,
      hubId,
      deliveredAt: "2026-06-24T12:34:00.000Z",
      onTime: true,
      occurredAt: "2026-06-24T12:34:00.000Z",
    },
  };
}

function fold(events: OccurredEvent[]): PackageLocationState {
  return events.reduce(packageLocationReducer, emptyPackageLocationState);
}

describe("packageLocationReducer — PackageDelivered purge (OUT-04 / D-22-1)", () => {
  it("purges the package row from packageLocation (Map.delete)", () => {
    const state = fold([
      evt(arrived("PKG-DEL-001", "hub-spoke-a"), "2026-06-24T08:00:00.000Z"),
      evt(delivered("PKG-DEL-001", "hub-spoke-a"), "2026-06-24T12:34:00.000Z"),
    ]);
    expect(state.get("PKG-DEL-001")).toBeUndefined();
    expect(state.size).toBe(0);
  });

  it("is a no-op on a missing packageId (idempotent — does not throw, D-22-1)", () => {
    const after = packageLocationReducer(
      emptyPackageLocationState,
      evt(delivered("GHOST-99", "hub-spoke-a"), "2026-06-24T12:34:00.000Z"),
    );
    expect(after.size).toBe(0);
  });

  it("leaves OTHER package rows intact when purging one", () => {
    const state = fold([
      evt(arrived("PKG-A", "hub-spoke-a"), "2026-06-24T08:00:00.000Z"),
      evt(arrived("PKG-B", "hub-spoke-b"), "2026-06-24T08:01:00.000Z"),
      evt(delivered("PKG-A", "hub-spoke-a"), "2026-06-24T12:34:00.000Z"),
    ]);
    expect(state.get("PKG-A")).toBeUndefined();
    expect(state.get("PKG-B")?.hubId).toBe("hub-spoke-b");
    expect(state.size).toBe(1);
  });

  it("re-applying the same PackageDelivered is idempotent (crash-safe replay)", () => {
    const seed = fold([
      evt(arrived("PKG-A", "hub-spoke-a"), "2026-06-24T08:00:00.000Z"),
    ]);
    const e = evt(delivered("PKG-A", "hub-spoke-a"), "2026-06-24T12:34:00.000Z");
    const once = packageLocationReducer(seed, e);
    const twice = packageLocationReducer(once, e);
    expect(twice.get("PKG-A")).toBeUndefined();
    expect(twice.size).toBe(0);
  });
});
