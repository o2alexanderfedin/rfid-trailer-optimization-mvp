import { describe, expect, it } from "vitest";
import type { OccurredEvent } from "../src/reducers/reducer.js";
import {
  emptyInductionDeadlineState,
  inductionDeadlineReducer,
  type InductionDeadlineState,
} from "../src/reducers/induction-deadline.js";

/**
 * PERF-02 — induction-deadline reducer unit tests.
 *
 * The reducer is a trivial LWW (last-write-wins) map keyed by packageId,
 * driven only by `PackageInducted`. All other event types are no-ops (closed
 * switch + assertNeverEvent).
 *
 * Assertions:
 *   1. Empty fold → empty Map
 *   2. Two PackageInducted for the same packageId → last-write-wins deadline
 *   3. Non-PackageInducted event → state unchanged (reference equality)
 */

const T0 = Date.parse("2026-07-01T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function inducted(packageId: string, slaDeadlineIso: string): OccurredEvent {
  return {
    event: {
      type: "PackageInducted",
      schemaVersion: 1,
      payload: { packageId, inductionHubId: "HUB-MEM", slaDeadlineIso },
    },
    occurredAt: at(0),
  };
}

function noopEvent(): OccurredEvent {
  return {
    event: {
      type: "HubRegistered",
      schemaVersion: 1,
      payload: { hubId: "HUB-X", name: "Hub X", lat: 35.0, lon: -90.0 },
    },
    occurredAt: at(0),
  };
}

/** Convert ISO string → epoch-minutes (matches isoToEpochMinutes from @mm/domain). */
function epochMin(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 60_000);
}

describe("inductionDeadlineReducer", () => {
  it("empty fold yields empty Map", () => {
    const state: InductionDeadlineState = emptyInductionDeadlineState;
    expect(state.size).toBe(0);
  });

  it("PackageInducted sets packageId → epoch-minutes", () => {
    const deadline = "2026-07-10T12:00:00.000Z";
    const state = inductionDeadlineReducer(
      emptyInductionDeadlineState,
      inducted("PKG-1", deadline),
    );
    expect(state.size).toBe(1);
    expect(state.get("PKG-1")).toBe(epochMin(deadline));
  });

  it("two PackageInducted for the same packageId → last-write-wins", () => {
    const first = "2026-07-10T12:00:00.000Z";
    const second = "2026-07-11T08:00:00.000Z";
    let state = inductionDeadlineReducer(
      emptyInductionDeadlineState,
      inducted("PKG-1", first),
    );
    state = inductionDeadlineReducer(state, inducted("PKG-1", second));
    // Only one row; deadline is the second (LWW)
    expect(state.size).toBe(1);
    expect(state.get("PKG-1")).toBe(epochMin(second));
  });

  it("multiple different packages → each gets its own deadline", () => {
    let state = emptyInductionDeadlineState;
    state = inductionDeadlineReducer(state, inducted("PKG-A", "2026-07-10T00:00:00.000Z"));
    state = inductionDeadlineReducer(state, inducted("PKG-B", "2026-07-12T00:00:00.000Z"));
    expect(state.size).toBe(2);
    expect(state.get("PKG-A")).toBe(epochMin("2026-07-10T00:00:00.000Z"));
    expect(state.get("PKG-B")).toBe(epochMin("2026-07-12T00:00:00.000Z"));
  });

  it("non-PackageInducted event leaves state unchanged (reference equality)", () => {
    const populated = inductionDeadlineReducer(
      emptyInductionDeadlineState,
      inducted("PKG-1", "2026-07-10T00:00:00.000Z"),
    );
    const after = inductionDeadlineReducer(populated, noopEvent());
    expect(after).toBe(populated); // same reference — no mutation
  });
});
