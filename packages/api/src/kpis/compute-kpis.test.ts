/**
 * Tests for `computeKpis` — the pure KPI computation function.
 *
 * Plan 05-03, Task 1 (TDD RED → GREEN).
 *
 * Verifies:
 *  - returns full KpiSnapshot shape from plan scores + exception counts.
 *  - wrongTrailerCount / missedUnloadCount from exception kinds (P3).
 *  - utilization + rehandle reuse scorePlan outputs (P8 — not re-implemented).
 *  - determinism: same inputs → identical KpiSnapshot (no Date.now, no float drift).
 *  - returned shape matches the ws envelope KpiSnapshot (minus baseline).
 */

import { describe, expect, it } from "vitest";
import type { KpiSnapshot } from "../ws/envelope.js";
import { computeKpis, type KpiInput } from "./compute-kpis.js";
import type { OpenException } from "@mm/projections";
import type { ExceptionKpiSnapshot } from "@mm/projections";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeException(
  id: string,
  kind: OpenException["kind"],
): OpenException {
  return {
    exceptionId: id,
    kind,
    packageId: `PKG-${id}`,
    trailerId: "TRL-1",
    hubId: kind === "missed-unload" ? "HUB-1" : null,
    severity: "warning",
    recommendedAction: "check",
    confidence: 0.85,
    occurredAt: "2026-01-01T00:00:00.000Z",
    reasonCode: null,
    suggestionId: null,
    label: null,
  };
}

function makeExceptionKpi(total: number, lowConf: number): ExceptionKpiSnapshot {
  return {
    totalExceptions: total,
    lowConfidenceExceptions: lowConf,
    falsePositiveRate: total === 0 ? 0 : lowConf / total,
  };
}

const BASE_INPUT: KpiInput = {
  optimizerRehandleScore: 40,
  optimizerUtilizationScore: 0.02,
  utilizationFraction: 0.82,
  trailerCount: 5,
  onTimeDepartureCount: 4,
  onTimeArrivalCount: 3,
  totalDepartureCount: 5,
  totalArrivalCount: 4,
  openExceptions: [],
  exceptionKpi: makeExceptionKpi(0, 0),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeKpis", () => {
  it("returns a KpiSnapshot with all required fields", () => {
    const result = computeKpis(BASE_INPUT);

    // Shape check — every field must be present and a number
    const fieldNames: Array<keyof Omit<KpiSnapshot, "baseline">> = [
      "utilization",
      "rehandleCount",
      "rehandleMinutes",
      "wrongTrailerCount",
      "missedUnloadCount",
      "slaViolationRate",
      "onTimeDeparture",
      "onTimeArrival",
    ];
    for (const field of fieldNames) {
      expect(typeof result[field], `field ${field}`).toBe("number");
    }
  });

  it("maps wrongTrailerCount and missedUnloadCount from exception kinds", () => {
    const input: KpiInput = {
      ...BASE_INPUT,
      openExceptions: [
        makeException("E1", "wrong-trailer"),
        makeException("E2", "wrong-trailer"),
        makeException("E3", "missed-unload"),
      ],
    };
    const result = computeKpis(input);
    expect(result.wrongTrailerCount).toBe(2);
    expect(result.missedUnloadCount).toBe(1);
  });

  it("returns 0 counts when no exceptions", () => {
    const result = computeKpis(BASE_INPUT);
    expect(result.wrongTrailerCount).toBe(0);
    expect(result.missedUnloadCount).toBe(0);
  });

  it("computes utilization from the provided utilizationFraction", () => {
    const input: KpiInput = { ...BASE_INPUT, utilizationFraction: 0.75 };
    const result = computeKpis(input);
    expect(result.utilization).toBeCloseTo(0.75, 5);
  });

  it("derives rehandleCount from optimizerRehandleScore via scoring plumbing (P8 reuse)", () => {
    // rehandleScore is a cost in minutes; rehandleCount is derived as the integer
    // number of blocker operations from the cost model.
    // When score > 0, rehandleCount must be > 0.
    const inputWithRehandle: KpiInput = { ...BASE_INPUT, optimizerRehandleScore: 60 };
    const inputNoRehandle: KpiInput = { ...BASE_INPUT, optimizerRehandleScore: 0 };
    expect(computeKpis(inputWithRehandle).rehandleCount).toBeGreaterThan(0);
    expect(computeKpis(inputNoRehandle).rehandleCount).toBe(0);
  });

  it("derives rehandleMinutes from optimizerRehandleScore", () => {
    const input: KpiInput = { ...BASE_INPUT, optimizerRehandleScore: 90 };
    const result = computeKpis(input);
    // rehandleMinutes reflects the cost in minutes
    expect(result.rehandleMinutes).toBeGreaterThan(0);
    // rehandleMinutes must be bounded: at most the full score (score IS the minutes)
    expect(result.rehandleMinutes).toBeLessThanOrEqual(input.optimizerRehandleScore);
  });

  it("computes onTimeDeparture ratio", () => {
    const input: KpiInput = {
      ...BASE_INPUT,
      onTimeDepartureCount: 3,
      totalDepartureCount: 4,
    };
    const result = computeKpis(input);
    expect(result.onTimeDeparture).toBeCloseTo(0.75, 5);
  });

  it("computes onTimeArrival ratio", () => {
    const input: KpiInput = {
      ...BASE_INPUT,
      onTimeArrivalCount: 2,
      totalArrivalCount: 5,
    };
    const result = computeKpis(input);
    expect(result.onTimeArrival).toBeCloseTo(0.4, 5);
  });

  // F-03 (HIGH / UI-03): a 0/0 on-time is NO DATA, not a fabricated 100%.
  // The previous behavior returned 1.0 (a dishonest "always on-time" metric).
  // The honest behavior surfaces `null` so the UI can render "—".
  it("returns null (no data) for onTimeDeparture when no departures have occurred", () => {
    const input: KpiInput = {
      ...BASE_INPUT,
      onTimeDepartureCount: 0,
      totalDepartureCount: 0,
    };
    const result = computeKpis(input);
    expect(result.onTimeDeparture).toBeNull();
    expect(result.onTimeDeparture).not.toBe(1);
  });

  it("returns null (no data) for onTimeArrival when no arrivals have occurred", () => {
    const input: KpiInput = {
      ...BASE_INPUT,
      onTimeArrivalCount: 0,
      totalArrivalCount: 0,
    };
    const result = computeKpis(input);
    expect(result.onTimeArrival).toBeNull();
    expect(result.onTimeArrival).not.toBe(1);
  });

  // F-03: when the route has no schedule data at all, the counts are passed as
  // `null` (not a fabricated 0). The KPI must surface as unavailable (null),
  // NEVER as a fabricated 100%.
  it("returns null when on-time counts are unavailable (null inputs — no schedule data)", () => {
    const input: KpiInput = {
      ...BASE_INPUT,
      onTimeDepartureCount: null,
      onTimeArrivalCount: null,
      totalDepartureCount: null,
      totalArrivalCount: null,
    };
    const result = computeKpis(input);
    expect(result.onTimeDeparture).toBeNull();
    expect(result.onTimeArrival).toBeNull();
  });

  it("computes a real on-time ratio < 1 when a late departure occurred (not a fake 100%)", () => {
    // Real counts: 1 of 2 departures on time → 0.5. This proves the metric is
    // honest: a late departure must drag the rate below 100%.
    const input: KpiInput = {
      ...BASE_INPUT,
      onTimeDepartureCount: 1,
      totalDepartureCount: 2,
    };
    const result = computeKpis(input);
    expect(result.onTimeDeparture).toBeCloseTo(0.5, 5);
    expect(result.onTimeDeparture).toBeLessThan(1);
  });

  it("derives slaViolationRate from falsePositiveRate (exception KPI)", () => {
    const input: KpiInput = {
      ...BASE_INPUT,
      exceptionKpi: makeExceptionKpi(10, 2),
    };
    const result = computeKpis(input);
    // slaViolationRate is a number in [0,1]
    expect(result.slaViolationRate).toBeGreaterThanOrEqual(0);
    expect(result.slaViolationRate).toBeLessThanOrEqual(1);
  });

  it("is deterministic: identical inputs produce identical output (P3)", () => {
    const input: KpiInput = {
      ...BASE_INPUT,
      openExceptions: [
        makeException("E1", "wrong-trailer"),
        makeException("E2", "missed-unload"),
      ],
      exceptionKpi: makeExceptionKpi(5, 1),
    };
    const result1 = computeKpis(input);
    const result2 = computeKpis(input);
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
  });

  it("is structurally assignable to Omit<KpiSnapshot,'baseline'>", () => {
    // TypeScript compile-time check: this assignment must compile without error.
    const result = computeKpis(BASE_INPUT);
    const _: Omit<KpiSnapshot, "baseline"> = result;
    expect(_).toBeDefined();
  });
});
