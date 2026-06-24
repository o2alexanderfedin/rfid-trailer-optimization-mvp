import { describe, expect, it } from "vitest";
import {
  STOP_COLORS,
  STOP_STATUS_LABELS,
  stopStyle,
  trailerStatusLabelFor,
} from "./stopColoring.js";
import type { FeatureLike } from "ol/Feature.js";

/**
 * SP2 Task 6 — the parked/refueling truck-status coloring (spec §8). `STOP_COLORS`
 * / `STOP_STATUS_LABELS` are the SINGLE source of truth for BOTH the stop-marker
 * StyleFunction (layers.ts) and the Legend "Truck status" section, so they can
 * never diverge. Pure, zero-per-frame allocation (a pre-allocated Style per kind).
 */

/** Minimal FeatureLike stub: just `get(key)` over a fixed prop bag. */
function feature(props: Record<string, unknown>): FeatureLike {
  return { get: (k: string): unknown => props[k] } as unknown as FeatureLike;
}

describe("stopColoring — distinct parked/refueling marker styles (spec §8)", () => {
  it("exposes a distinct color + label for `rested` and `refueling`", () => {
    expect(STOP_COLORS.rested).toBeDefined();
    expect(STOP_COLORS.refueling).toBeDefined();
    expect(STOP_COLORS.rested).not.toBe(STOP_COLORS.refueling);
    expect(STOP_STATUS_LABELS.length).toBeGreaterThanOrEqual(3); // moving + rested + refueling
  });

  it("stopStyle returns a DISTINCT cached Style per stop kind", () => {
    const rested = stopStyle(feature({ kind: "rested" }));
    const refueling = stopStyle(feature({ kind: "refueling" }));
    expect(rested).toBeDefined();
    expect(refueling).toBeDefined();
    // Different kinds ⇒ different (pre-allocated) Style references.
    expect(rested).not.toBe(refueling);
  });

  it("stopStyle returns the SAME cached Style for the same kind (zero per-frame alloc)", () => {
    expect(stopStyle(feature({ kind: "rested" }))).toBe(stopStyle(feature({ kind: "rested" })));
  });

  it("stopStyle falls back to a default Style for an unknown/missing kind", () => {
    const a = stopStyle(feature({}));
    const b = stopStyle(feature({ kind: "wat" }));
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it("trailerStatusLabelFor maps each state to a human label", () => {
    expect(trailerStatusLabelFor("rested")).toMatch(/rest|park/i);
    expect(trailerStatusLabelFor("refueling")).toMatch(/fuel/i);
    expect(trailerStatusLabelFor("moving")).toMatch(/mov/i);
  });
});
