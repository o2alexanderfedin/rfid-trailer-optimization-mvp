/**
 * dutyColoring tests (VIZ-11) — runs in the node `unit` lane (`*.test.ts`).
 *
 * The driver-duty distribution → hub-marker styling is pure, integer-bucket
 * logic over the ws `HubState` driver buckets (`driverCount` / `onBreakCount`
 * / `restingCount`, all added in Phase 14). These tests pin the classification
 * and the color/label single-source-of-truth so the map + legend can never
 * diverge (mirrors `coloring.test.ts`).
 */
import { describe, expect, it } from "vitest";
import type { HubState } from "@mm/api";
import {
  DUTY_COLORS,
  DUTY_BUCKET_LABELS,
  classifyDutyBucket,
  hubHasDriverData,
} from "./dutyColoring.js";

/** Build a HubState with the given driver buckets (other buckets are 0). */
function hub(
  partial: Pick<HubState, "driverCount" | "onBreakCount" | "restingCount">,
): HubState {
  return {
    id: "H",
    volumeBucket: 0,
    slaRiskBucket: 0,
    congestionBucket: 0,
    ...partial,
  };
}

describe("DUTY_COLORS / DUTY_BUCKET_LABELS (single source of truth)", () => {
  it("has one color per label (1:1, same length)", () => {
    expect(DUTY_COLORS).toHaveLength(DUTY_BUCKET_LABELS.length);
    expect(DUTY_COLORS.length).toBeGreaterThan(0);
  });

  it("colors are distinct hex strings", () => {
    const set = new Set(DUTY_COLORS);
    expect(set.size).toBe(DUTY_COLORS.length);
    for (const c of DUTY_COLORS) expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

describe("hubHasDriverData", () => {
  it("is false when no driver buckets are present (back-compat / older server)", () => {
    expect(
      hubHasDriverData({
        id: "H",
        volumeBucket: 1,
        slaRiskBucket: 0,
        congestionBucket: 0,
      }),
    ).toBe(false);
  });

  it("is false when driverCount is 0 (no drivers assigned at the hub)", () => {
    expect(hubHasDriverData(hub({ driverCount: 0, onBreakCount: 0, restingCount: 0 }))).toBe(
      false,
    );
  });

  it("is true when at least one driver is assigned", () => {
    expect(hubHasDriverData(hub({ driverCount: 2, onBreakCount: 0, restingCount: 0 }))).toBe(
      true,
    );
  });
});

describe("classifyDutyBucket", () => {
  it("returns null when the hub has no driver data (fall back to volume coloring)", () => {
    expect(
      classifyDutyBucket({
        id: "H",
        volumeBucket: 1,
        slaRiskBucket: 0,
        congestionBucket: 0,
      }),
    ).toBeNull();
  });

  it("classifies all-driving/available (none on break or resting) as bucket 0", () => {
    expect(classifyDutyBucket(hub({ driverCount: 3, onBreakCount: 0, restingCount: 0 }))).toBe(
      0,
    );
  });

  it("classifies a mix with someone on break (but not all out) as bucket 1", () => {
    expect(classifyDutyBucket(hub({ driverCount: 3, onBreakCount: 1, restingCount: 0 }))).toBe(
      1,
    );
  });

  it("classifies a mix with someone resting (but not all out) as bucket 2", () => {
    expect(classifyDutyBucket(hub({ driverCount: 3, onBreakCount: 0, restingCount: 1 }))).toBe(
      2,
    );
  });

  it("classifies ALL drivers out of service (resting + on break = count) as bucket 3", () => {
    // 2 resting + 1 on break = 3 of 3 → no driver is available right now.
    expect(classifyDutyBucket(hub({ driverCount: 3, onBreakCount: 1, restingCount: 2 }))).toBe(
      3,
    );
  });

  it("classifies all-resting as the all-out bucket 3", () => {
    expect(classifyDutyBucket(hub({ driverCount: 2, onBreakCount: 0, restingCount: 2 }))).toBe(
      3,
    );
  });

  it("is a valid index into DUTY_COLORS for every non-null result", () => {
    const samples: HubState[] = [
      hub({ driverCount: 1, onBreakCount: 0, restingCount: 0 }),
      hub({ driverCount: 4, onBreakCount: 1, restingCount: 0 }),
      hub({ driverCount: 4, onBreakCount: 0, restingCount: 1 }),
      hub({ driverCount: 4, onBreakCount: 2, restingCount: 2 }),
    ];
    for (const s of samples) {
      const b = classifyDutyBucket(s);
      expect(b).not.toBeNull();
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b! < DUTY_COLORS.length).toBe(true);
    }
  });
});
