import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";
import {
  type DeliveryKpiState,
  deliveryKpiReducer,
  emptyDeliveryKpiState,
} from "./delivery-kpi.js";
import type { OccurredEvent } from "./reducer.js";

/**
 * OUT-05 (P2) / D-22-3 — the event-derived delivery KPI reducer. Counters are
 * accumulated PER `PackageDelivered` event (monotonic), never a row-count over
 * the DELETE-purged package tables.
 */

function evt(event: DomainEvent): OccurredEvent {
  return { event, occurredAt: "2026-06-24T12:34:00.000Z" };
}

function delivered(onTime: boolean): DomainEvent {
  return {
    type: "PackageDelivered",
    schemaVersion: 1,
    payload: {
      packageId: "PKG-1",
      hubId: "hub-spoke-a",
      deliveredAt: "2026-06-24T12:34:00.000Z",
      onTime,
      occurredAt: "2026-06-24T12:34:00.000Z",
    },
  };
}

const arrived: DomainEvent = {
  type: "PackageArrivedAtHub",
  schemaVersion: 1,
  payload: { packageId: "PKG-1", hubId: "hub-spoke-a" },
};

function fold(events: DomainEvent[]): DeliveryKpiState {
  return events.reduce(
    (s, e) => deliveryKpiReducer(s, evt(e)),
    emptyDeliveryKpiState,
  );
}

describe("deliveryKpiReducer (OUT-05 / D-22-3)", () => {
  it("starts empty: { deliveredCount: 0, onTimeCount: 0 }", () => {
    expect(emptyDeliveryKpiState).toEqual({ deliveredCount: 0, onTimeCount: 0 });
  });

  it("on-time delivery increments BOTH deliveredCount and onTimeCount", () => {
    const state = deliveryKpiReducer(emptyDeliveryKpiState, evt(delivered(true)));
    expect(state).toEqual({ deliveredCount: 1, onTimeCount: 1 });
  });

  it("late delivery increments deliveredCount only (onTimeCount unchanged)", () => {
    const state = deliveryKpiReducer(emptyDeliveryKpiState, evt(delivered(false)));
    expect(state).toEqual({ deliveredCount: 1, onTimeCount: 0 });
  });

  it("any other event type leaves the state unchanged (same reference)", () => {
    const before = { deliveredCount: 3, onTimeCount: 2 };
    const after = deliveryKpiReducer(before, evt(arrived));
    expect(after).toBe(before);
  });

  it("accumulates across a mixed stream (2 on-time, 1 late)", () => {
    const state = fold([
      delivered(true),
      delivered(false),
      delivered(true),
    ]);
    expect(state).toEqual({ deliveredCount: 3, onTimeCount: 2 });
  });
});
