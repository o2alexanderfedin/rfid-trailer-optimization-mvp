import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Point from "ol/geom/Point.js";
import { createInductionLayer, flashInduction } from "./layers.js";
import { inductionStyle } from "./inductionColoring.js";

/**
 * VIZ-13 (Plan 20-05) — the external-induction layer + flash animation.
 *
 * A `PackageInducted` ws event flashes a transient pulsing marker at the spoke
 * hub for ~2s, then it self-removes. The induction StyleFunction is zero-alloc
 * (one pre-allocated Style returned by reference).
 */

describe("induction layer (VIZ-13)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flashInduction adds a transient Point feature at the hub position", () => {
    const { source } = createInductionLayer();
    flashInduction(source, "MEM", -90, 35);
    expect(source.getFeatures().length).toBe(1);
    const f = source.getFeatures()[0]!;
    expect(f.getGeometry()).toBeInstanceOf(Point);
    expect(f.get("inductionHubId")).toBe("MEM");
  });

  it("removes the marker after the flash duration (~2000ms)", () => {
    const { source } = createInductionLayer();
    flashInduction(source, "MEM", -90, 35, 2000);
    expect(source.getFeatures().length).toBe(1);
    vi.advanceTimersByTime(1999);
    expect(source.getFeatures().length).toBe(1); // still flashing
    vi.advanceTimersByTime(1);
    expect(source.getFeatures().length).toBe(0); // self-removed
  });

  it("multiple inductions at the same hub do not collide (unique feature ids)", () => {
    const { source } = createInductionLayer();
    flashInduction(source, "MEM", -90, 35);
    flashInduction(source, "MEM", -90, 35);
    expect(source.getFeatures().length).toBe(2);
  });
});

describe("inductionStyle (zero-alloc StyleFunction)", () => {
  it("returns the SAME pre-allocated Style reference on every call", () => {
    expect(inductionStyle()).toBe(inductionStyle()); // same cached reference
  });
});
