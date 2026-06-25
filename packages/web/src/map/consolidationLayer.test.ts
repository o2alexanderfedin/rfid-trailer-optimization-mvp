import { describe, expect, it } from "vitest";
import type { FeatureLike } from "ol/Feature.js";
import { trailerStyle } from "./coloring.js";

/**
 * VIZ-12 (Plan 21-07) — consolidation trailers render with a DISTINCT style.
 *
 * `direction` is an optional+additive feature prop ("outbound" | "consolidation")
 * set by `upsertTrailerKeyframe`. `trailerStyle` branches on it: a consolidation
 * leg (spoke→center) returns the pre-allocated consolidation Style; an outbound
 * (or directionless) leg falls through to the existing state-keyed trailer style.
 *
 * Zero per-frame allocation: every branch returns a cached Style reference (one
 * pre-allocated Style at module load, the same discipline as inductionColoring).
 */

/** Minimal `FeatureLike` double — only `get(key)` is consulted by `trailerStyle`. */
function makeFeature(props: Record<string, unknown>): FeatureLike {
  return {
    get(key: string): unknown {
      return props[key];
    },
  } as unknown as FeatureLike;
}

describe("trailerStyle direction branch (VIZ-12)", () => {
  it("a consolidation trailer renders DIFFERENTLY than an outbound one", () => {
    const consolidation = makeFeature({ state: "onTime", direction: "consolidation" });
    const outbound = makeFeature({ state: "onTime", direction: "outbound" });
    expect(trailerStyle(consolidation)).not.toBe(trailerStyle(outbound));
  });

  it("an outbound trailer uses the existing state-keyed style (not the consolidation one)", () => {
    const outbound = makeFeature({ state: "onTime", direction: "outbound" });
    const plain = makeFeature({ state: "onTime" }); // no direction
    // Outbound is the default flow ⇒ same style as a directionless trailer.
    expect(trailerStyle(outbound)).toBe(trailerStyle(plain));
  });

  it("returns the SAME cached consolidation Style reference on every call (zero alloc)", () => {
    const a = makeFeature({ state: "onTime", direction: "consolidation" });
    const b = makeFeature({ state: "slaRisk", direction: "consolidation" });
    // The consolidation branch is direction-keyed, not state-keyed — one Style.
    expect(trailerStyle(a)).toBe(trailerStyle(b));
  });
});
