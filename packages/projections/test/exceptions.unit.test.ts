import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";
import {
  emptyExceptionsState,
  exceptionsReducer,
  type ExceptionsState,
  falsePositiveRate,
  type OccurredEvent,
  openExceptions,
} from "../src/index.js";

/**
 * Task 1 (RED -> GREEN), SNS-04/05: the EXCEPTIONS reducer + false-positive KPI.
 *
 * The exceptions read model is a PURE fold of `WrongTrailerDetected` /
 * `MissedUnloadDetected` into an open-exceptions map keyed by a stable
 * `exceptionId` (so re-applying the same detection event is an idempotent
 * upsert — the same row), plus a false-positive-rate KPI derived as a REAL
 * ratio (low-confidence exceptions / total), NOT a hardcoded placeholder.
 *
 * Discipline mirrors the other operational reducers: no wall clock, no RNG,
 * exhaustive over the closed 11-member `DomainEvent` union, and a no-op for the
 * 9 non-exception events (same state reference returned).
 */

const T0 = Date.parse("2026-05-01T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function evt(event: DomainEvent, occurredAt: string): OccurredEvent {
  return { event, occurredAt };
}

function wrongTrailer(
  packageId: string,
  observedTrailerId: string,
  plannedTrailerId: string,
  confidence: number,
  severity: "info" | "warning" | "critical" = "warning",
  recommendedAction = "recheck_before_departure",
): DomainEvent {
  return {
    type: "WrongTrailerDetected",
    schemaVersion: 1,
    payload: {
      packageId,
      observedTrailerId,
      plannedTrailerId,
      confidence,
      severity,
      recommendedAction,
    },
  };
}

function missedUnload(
  packageId: string,
  trailerId: string,
  hubId: string,
  confidence: number,
  severity: "info" | "warning" | "critical" = "critical",
  recommendedAction = "return_to_hub",
): DomainEvent {
  return {
    type: "MissedUnloadDetected",
    schemaVersion: 1,
    payload: { packageId, trailerId, hubId, confidence, severity, recommendedAction },
  };
}

function pkgCreated(packageId: string): DomainEvent {
  return {
    type: "PackageCreated",
    schemaVersion: 1,
    payload: {
      packageId,
      originHubId: "MEM",
      destHubId: "LAX",
      sizeClass: "medium",
      weight: 10,
    },
  };
}

function fold(events: OccurredEvent[]): ExceptionsState {
  return events.reduce(exceptionsReducer, emptyExceptionsState);
}

describe("exceptionsReducer (SNS-04/05)", () => {
  it("folds a WrongTrailerDetected into an open exception row (severity + recommendedAction)", () => {
    const state = fold([
      evt(wrongTrailer("PKG-1", "TRL-B", "TRL-A", 0.82, "warning", "recheck_before_departure"), at(0)),
    ]);
    const open = openExceptions(state);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      kind: "wrong-trailer",
      packageId: "PKG-1",
      trailerId: "TRL-B",
      severity: "warning",
      recommendedAction: "recheck_before_departure",
      confidence: 0.82,
    });
    expect(open[0]?.exceptionId).toBeTruthy();
  });

  it("folds a MissedUnloadDetected into an open exception row (kind missed-unload, hubId set)", () => {
    const state = fold([
      evt(missedUnload("PKG-9", "TRL-X", "DFW", 0.9, "critical", "return_to_hub"), at(0)),
    ]);
    const open = openExceptions(state);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      kind: "missed-unload",
      packageId: "PKG-9",
      trailerId: "TRL-X",
      hubId: "DFW",
      severity: "critical",
      recommendedAction: "return_to_hub",
    });
  });

  it("orders open exceptions deterministically by occurredAt then exceptionId", () => {
    const state = fold([
      evt(missedUnload("PKG-2", "TRL-X", "DFW", 0.9), at(2000)),
      evt(wrongTrailer("PKG-1", "TRL-B", "TRL-A", 0.82), at(1000)),
      evt(wrongTrailer("PKG-3", "TRL-C", "TRL-A", 0.7), at(1000)),
    ]);
    const ids = openExceptions(state).map((e) => e.packageId);
    // at(1000) PKG-1 + PKG-3 (tie broken by exceptionId), then at(2000) PKG-2.
    expect(ids[ids.length - 1]).toBe("PKG-2");
    expect(ids.slice(0, 2).sort()).toEqual(["PKG-1", "PKG-3"]);
  });

  it("is idempotent: re-applying the SAME detection event upserts the same row (no double-count)", () => {
    const e = evt(wrongTrailer("PKG-1", "TRL-B", "TRL-A", 0.82), at(0));
    const once = fold([e]);
    const twice = fold([e, e]);
    expect(openExceptions(twice)).toHaveLength(1);
    expect(twice.totalExceptions).toBe(once.totalExceptions);
    expect(openExceptions(twice)).toEqual(openExceptions(once));
  });

  it("the 9 non-exception events are no-ops (same state reference)", () => {
    const base = fold([evt(wrongTrailer("PKG-1", "TRL-B", "TRL-A", 0.82), at(0))]);
    const after = exceptionsReducer(base, evt(pkgCreated("PKG-2"), at(1000)));
    expect(after).toBe(base);
  });

  it("false-positive-rate is a REAL ratio: info-severity exceptions / total (not a placeholder)", () => {
    // 1 credible (warning/critical) + 3 marginal (info) => FP-rate 3/4. The KPI
    // tracks the LOWEST-severity rung the calibrated detector assigns to the
    // near-the-gate disagreements most likely to be false positives.
    const state = fold([
      evt(wrongTrailer("PKG-HI", "TRL-B", "TRL-A", 0.4, "warning"), at(0)),
      evt(wrongTrailer("PKG-LO1", "TRL-B", "TRL-A", 0.38, "info"), at(1000)),
      evt(wrongTrailer("PKG-LO2", "TRL-B", "TRL-A", 0.37, "info"), at(2000)),
      evt(missedUnload("PKG-LO3", "TRL-X", "DFW", 0.36, "info"), at(3000)),
    ]);
    expect(state.totalExceptions).toBe(4);
    expect(state.lowConfidenceExceptions).toBe(3);
    expect(falsePositiveRate(state)).toBeCloseTo(0.75, 10);
  });

  it("false-positive-rate is 0 when there are no exceptions (no divide-by-zero)", () => {
    expect(falsePositiveRate(emptyExceptionsState)).toBe(0);
  });

  it("is PURE: identical event sequences produce equal state", () => {
    const events = [
      evt(wrongTrailer("PKG-1", "TRL-B", "TRL-A", 0.82), at(0)),
      evt(missedUnload("PKG-2", "TRL-X", "DFW", 0.65), at(1000)),
    ];
    expect(openExceptions(fold(events))).toEqual(openExceptions(fold(events)));
  });
});
