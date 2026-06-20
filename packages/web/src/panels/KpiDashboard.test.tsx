/**
 * KpiDashboard tests (TDD RED → GREEN).
 *
 * Tests the pure KPI state-management logic extracted from KpiDashboard:
 *  - `applyKpiPartial`: merges a Partial<KpiSnapshot> onto the current snapshot
 *  - `formatKpiValue`: formats a KPI value (count vs percentage vs fraction)
 *  - `shouldAnimate`: determines if a field changed (to trigger animation)
 *  - `kpiCards`: returns the ordered card definitions for rendering
 *
 * The business logic is in pure functions — no DOM/React required.
 * The component itself is a thin shell over these helpers.
 */
import { describe, expect, it } from "vitest";
import {
  applyKpiPartial,
  formatKpiValue,
  shouldAnimate,
  kpiCards,
  type KpiState,
  type KpiCardDef,
} from "./KpiDashboard.js";
import type { KpiSnapshot } from "@mm/api";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMPTY_BASELINE: Omit<KpiSnapshot, "baseline"> = {
  utilization: 0,
  rehandleCount: 0,
  rehandleMinutes: 0,
  wrongTrailerCount: 0,
  missedUnloadCount: 0,
  slaViolationRate: 0,
  onTimeDeparture: 1,
  onTimeArrival: 1,
};

function makeSnapshot(overrides: Partial<Omit<KpiSnapshot, "baseline">> = {}): KpiSnapshot {
  return {
    utilization: overrides.utilization ?? 0.75,
    rehandleCount: overrides.rehandleCount ?? 3,
    rehandleMinutes: overrides.rehandleMinutes ?? 18.5,
    wrongTrailerCount: overrides.wrongTrailerCount ?? 1,
    missedUnloadCount: overrides.missedUnloadCount ?? 0,
    slaViolationRate: overrides.slaViolationRate ?? 0.05,
    onTimeDeparture: overrides.onTimeDeparture ?? 0.94,
    onTimeArrival: overrides.onTimeArrival ?? 0.91,
    baseline: EMPTY_BASELINE,
  };
}

function makeState(snap: KpiSnapshot): KpiState {
  return { current: snap, animatingFields: new Set() };
}

// ---------------------------------------------------------------------------
// applyKpiPartial
// ---------------------------------------------------------------------------

describe("applyKpiPartial", () => {
  it("merges only changed fields onto the current snapshot", () => {
    const prev = makeSnapshot();
    const partial: Partial<KpiSnapshot> = { rehandleCount: 5, slaViolationRate: 0.1 };
    const next = applyKpiPartial(prev, partial);

    expect(next.rehandleCount).toBe(5);
    expect(next.slaViolationRate).toBeCloseTo(0.1);
    // unchanged fields preserved
    expect(next.utilization).toBe(prev.utilization);
    expect(next.wrongTrailerCount).toBe(prev.wrongTrailerCount);
    expect(next.baseline).toBe(prev.baseline);
  });

  it("returns a new object (immutable update)", () => {
    const prev = makeSnapshot();
    const next = applyKpiPartial(prev, { rehandleCount: 10 });
    expect(next).not.toBe(prev);
  });

  it("applies an empty partial without changes", () => {
    const prev = makeSnapshot();
    const next = applyKpiPartial(prev, {});
    expect(next).toStrictEqual(prev);
  });

  it("handles partial with all fields updated", () => {
    const prev = makeSnapshot();
    const full: Partial<KpiSnapshot> = {
      utilization: 0.9,
      rehandleCount: 0,
      rehandleMinutes: 0,
      wrongTrailerCount: 0,
      missedUnloadCount: 0,
      slaViolationRate: 0,
      onTimeDeparture: 1,
      onTimeArrival: 1,
    };
    const next = applyKpiPartial(prev, full);
    expect(next.utilization).toBeCloseTo(0.9);
    expect(next.rehandleCount).toBe(0);
    expect(next.slaViolationRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// shouldAnimate
// ---------------------------------------------------------------------------

describe("shouldAnimate", () => {
  it("returns true when a numeric field value changes", () => {
    const prev = makeSnapshot({ rehandleCount: 2 });
    const next = makeSnapshot({ rehandleCount: 5 });
    expect(shouldAnimate("rehandleCount", prev, next)).toBe(true);
  });

  it("returns false when a field is unchanged", () => {
    const snap = makeSnapshot();
    expect(shouldAnimate("utilization", snap, snap)).toBe(false);
  });

  it("returns true for rate fields that change", () => {
    const prev = makeSnapshot({ slaViolationRate: 0.05 });
    const next = makeSnapshot({ slaViolationRate: 0.08 });
    expect(shouldAnimate("slaViolationRate", prev, next)).toBe(true);
  });

  it("returns false for the baseline field (it never updates live)", () => {
    // baseline is not a per-tick animatable field
    const snap = makeSnapshot();
    expect(shouldAnimate("baseline", snap, snap)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatKpiValue
// ---------------------------------------------------------------------------

describe("formatKpiValue", () => {
  it("formats integer count fields as whole numbers", () => {
    expect(formatKpiValue("rehandleCount", 7)).toBe("7");
    expect(formatKpiValue("wrongTrailerCount", 0)).toBe("0");
    expect(formatKpiValue("missedUnloadCount", 12)).toBe("12");
  });

  it("formats rehandleMinutes as a decimal with 1dp", () => {
    expect(formatKpiValue("rehandleMinutes", 18.5)).toBe("18.5 min");
    expect(formatKpiValue("rehandleMinutes", 0)).toBe("0.0 min");
    expect(formatKpiValue("rehandleMinutes", 72.5)).toBe("72.5 min");
  });

  it("formats rate / fraction fields as percentages with 1dp", () => {
    expect(formatKpiValue("utilization", 0.75)).toBe("75.0%");
    expect(formatKpiValue("slaViolationRate", 0.05)).toBe("5.0%");
    expect(formatKpiValue("onTimeDeparture", 0.94)).toBe("94.0%");
    expect(formatKpiValue("onTimeArrival", 0.91)).toBe("91.0%");
  });

  it("formats utilization 0 as 0%", () => {
    expect(formatKpiValue("utilization", 0)).toBe("0.0%");
  });

  it("formats 100% correctly", () => {
    expect(formatKpiValue("onTimeDeparture", 1.0)).toBe("100.0%");
  });
});

// ---------------------------------------------------------------------------
// kpiCards
// ---------------------------------------------------------------------------

describe("kpiCards", () => {
  it("returns exactly 8 card definitions", () => {
    const cards: readonly KpiCardDef[] = kpiCards();
    expect(cards).toHaveLength(8);
  });

  it("covers all 8 operational KPI fields", () => {
    const cards = kpiCards();
    const fields = cards.map((c) => c.field);
    expect(fields).toContain("utilization");
    expect(fields).toContain("rehandleCount");
    expect(fields).toContain("rehandleMinutes");
    expect(fields).toContain("wrongTrailerCount");
    expect(fields).toContain("missedUnloadCount");
    expect(fields).toContain("slaViolationRate");
    expect(fields).toContain("onTimeDeparture");
    expect(fields).toContain("onTimeArrival");
  });

  it("every card has a non-empty label", () => {
    const cards = kpiCards();
    for (const card of cards) {
      expect(card.label.length).toBeGreaterThan(0);
    }
  });

  it("every card has a non-empty field key from KpiSnapshot", () => {
    const cards = kpiCards();
    for (const card of cards) {
      expect(typeof card.field).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// KpiState shape
// ---------------------------------------------------------------------------

describe("KpiState", () => {
  it("applyKpiPartial produces a state where animatingFields contains changed keys", () => {
    // This tests the integration of state tracking:
    // fields that changed should be in animatingFields
    const prev = makeSnapshot({ rehandleCount: 2 });
    const next = applyKpiPartial(prev, { rehandleCount: 7 });
    const animatingFields = new Set(
      (Object.keys(next) as (keyof Omit<KpiSnapshot, "baseline">)[]).filter(
        (k) => k !== "baseline" && shouldAnimate(k, prev, next),
      ),
    );
    expect(animatingFields.has("rehandleCount")).toBe(true);
    expect(animatingFields.has("utilization")).toBe(false);
  });

  it("KpiState type holds current + animatingFields", () => {
    const state: KpiState = makeState(makeSnapshot());
    expect(state.current).toBeDefined();
    expect(state.animatingFields).toBeDefined();
    expect(state.animatingFields instanceof Set).toBe(true);
  });
});
