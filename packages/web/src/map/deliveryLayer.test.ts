import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Point from "ol/geom/Point.js";
import { createDeliveryLayer, flashDelivery } from "./layers.js";
import { deliveryStyle } from "./deliveryColoring.js";

/**
 * VIZ-14 (Plan 22-06) — the outbound-delivery layer + flash animation.
 *
 * A `PackageDelivered` ws event flashes a transient marker at the DESTINATION hub
 * for ~2s, then it self-removes. The delivery StyleFunction is zero-alloc (one
 * pre-allocated Style returned by reference) and distinct from induction purple /
 * consolidation cyan.
 *
 * RED until Plan 06 adds `createDeliveryLayer`/`flashDelivery` (layers.ts) +
 * `deliveryStyle`/`DELIVERY_COLOR` (deliveryColoring.ts).
 */

describe("delivery layer (VIZ-14)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flashDelivery adds a transient Point feature at the hub position", () => {
    const { source } = createDeliveryLayer();
    flashDelivery(source, "DFW", -97, 32);
    expect(source.getFeatures().length).toBe(1);
    const f = source.getFeatures()[0]!;
    expect(f.getGeometry()).toBeInstanceOf(Point);
    expect(f.get("deliveryHubId")).toBe("DFW");
  });

  it("removes the marker after the flash duration (~2000ms)", () => {
    const { source } = createDeliveryLayer();
    flashDelivery(source, "DFW", -97, 32, 2000);
    expect(source.getFeatures().length).toBe(1);
    vi.advanceTimersByTime(2001);
    expect(source.getFeatures().length).toBe(0); // self-removed
  });

  it("multiple deliveries at the same hub do not collide (unique feature ids)", () => {
    const { source } = createDeliveryLayer();
    flashDelivery(source, "DFW", -97, 32);
    flashDelivery(source, "DFW", -97, 32);
    expect(source.getFeatures().length).toBe(2);
  });
});

describe("deliveryStyle (zero-alloc StyleFunction)", () => {
  it("returns the SAME pre-allocated Style reference on every call", () => {
    expect(deliveryStyle()).toBe(deliveryStyle()); // same cached reference
  });
});
