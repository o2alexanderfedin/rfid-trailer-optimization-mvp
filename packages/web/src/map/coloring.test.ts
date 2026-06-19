/**
 * coloring.ts tests (TDD RED→GREEN).
 *
 * Tests the zero-allocation STYLE_CACHE, the StyleFunction behaviors,
 * and that the legend arrays (COLORS + LABELS) are consistent
 * with the cache.
 *
 * OL Style/Fill/Stroke/CircleStyle are mocked so tests run in Node env.
 */
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock OL style modules before importing the module under test.
// Use inline class definitions inside the factory to avoid hoisting issues.
// ---------------------------------------------------------------------------

vi.mock("ol/style.js", () => {
  class MockFill {
    constructor(readonly opts: { color: string }) {}
  }
  class MockStroke {
    constructor(readonly opts: { color: string; width: number }) {}
  }
  class MockCircleStyle {
    constructor(readonly opts: { radius: number; fill: MockFill; stroke?: MockStroke }) {}
  }
  class MockStyle {
    constructor(readonly opts: { image?: MockCircleStyle; stroke?: MockStroke }) {}
  }
  return {
    Style: MockStyle,
    Fill: MockFill,
    Stroke: MockStroke,
    Circle: MockCircleStyle,
  };
});

// Mock FeatureLike: simple object with a get() method.
function makeFeature(props: Record<string, unknown>) {
  return {
    get(key: string): unknown {
      return props[key];
    },
  };
}

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------
import {
  hubStyle,
  routeStyle,
  HUB_COLORS,
  HUB_BUCKET_LABELS,
  ROUTE_COLORS,
  ROUTE_BUCKET_LABELS,
} from "./coloring.js";
import type { FeatureLike } from "ol/Feature.js";

// ---------------------------------------------------------------------------
// COLORS / LABELS consistency (single source of truth)
// ---------------------------------------------------------------------------

describe("HUB_COLORS / HUB_BUCKET_LABELS", () => {
  it("have the same length", () => {
    expect(HUB_COLORS.length).toBe(HUB_BUCKET_LABELS.length);
  });

  it("have at least 2 entries (gradient meaningful)", () => {
    expect(HUB_COLORS.length).toBeGreaterThanOrEqual(2);
  });

  it("all color strings are non-empty hex values", () => {
    for (const color of HUB_COLORS) {
      expect(color).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    }
  });

  it("all label strings are non-empty", () => {
    for (const label of HUB_BUCKET_LABELS) {
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe("ROUTE_COLORS / ROUTE_BUCKET_LABELS", () => {
  it("have the same length", () => {
    expect(ROUTE_COLORS.length).toBe(ROUTE_BUCKET_LABELS.length);
  });

  it("have at least 2 entries", () => {
    expect(ROUTE_COLORS.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// hubStyle: zero-allocation StyleFunction
// ---------------------------------------------------------------------------

describe("hubStyle", () => {
  it("returns the same cached Style ref for bucket 0 every call (zero alloc)", () => {
    const f = makeFeature({ volumeBucket: 0 }) as FeatureLike;
    const r1 = hubStyle(f);
    const r2 = hubStyle(f);
    expect(r1).toBe(r2); // identity equality — same object reference
  });

  it("returns distinct cached Style refs for different buckets", () => {
    const f0 = makeFeature({ volumeBucket: 0 }) as FeatureLike;
    const f1 = makeFeature({ volumeBucket: 1 }) as FeatureLike;
    expect(hubStyle(f0)).not.toBe(hubStyle(f1));
  });

  it("returns the same ref for the max bucket", () => {
    const maxBucket = HUB_COLORS.length - 1;
    const f = makeFeature({ volumeBucket: maxBucket }) as FeatureLike;
    expect(hubStyle(f)).toBe(hubStyle(f));
  });

  it("returns the default style for an out-of-range bucket", () => {
    const f = makeFeature({ volumeBucket: 999 }) as FeatureLike;
    const fDefault = makeFeature({ volumeBucket: undefined }) as FeatureLike;
    // Both out-of-range → both return the default style (same ref).
    expect(hubStyle(f)).toBe(hubStyle(fDefault));
  });

  it("returns the default style when volumeBucket is undefined", () => {
    const f = makeFeature({}) as FeatureLike;
    const fNull = makeFeature({ volumeBucket: undefined }) as FeatureLike;
    expect(hubStyle(f)).toBe(hubStyle(fNull));
  });

  it("returns the default style for negative bucket", () => {
    const f = makeFeature({ volumeBucket: -1 }) as FeatureLike;
    const fDef = makeFeature({}) as FeatureLike;
    expect(hubStyle(f)).toBe(hubStyle(fDef));
  });

  it("returns a non-null style for every valid bucket (no allocation check)", () => {
    for (let b = 0; b < HUB_COLORS.length; b++) {
      const f = makeFeature({ volumeBucket: b }) as FeatureLike;
      expect(hubStyle(f)).toBeTruthy();
    }
  });

  it("STYLE_CACHE length equals HUB_COLORS length (pre-allocated, not grown)", () => {
    // Total distinct non-default returns == number of colors.
    const seen = new Set<unknown>();
    for (let b = 0; b < HUB_COLORS.length; b++) {
      const f = makeFeature({ volumeBucket: b }) as FeatureLike;
      seen.add(hubStyle(f));
    }
    expect(seen.size).toBe(HUB_COLORS.length);
  });
});

// ---------------------------------------------------------------------------
// routeStyle: zero-allocation StyleFunction
// ---------------------------------------------------------------------------

describe("routeStyle", () => {
  it("returns the same cached Style ref for bucket 0 every call", () => {
    const f = makeFeature({ loadBucket: 0 }) as FeatureLike;
    expect(routeStyle(f)).toBe(routeStyle(f));
  });

  it("returns the default style for missing/out-of-range bucket", () => {
    const fMissing = makeFeature({}) as FeatureLike;
    const fOutOfRange = makeFeature({ loadBucket: 999 }) as FeatureLike;
    expect(routeStyle(fMissing)).toBe(routeStyle(fOutOfRange));
  });

  it("returns distinct refs for distinct valid buckets", () => {
    if (ROUTE_COLORS.length < 2) return; // skip if only 1 bucket
    const f0 = makeFeature({ loadBucket: 0 }) as FeatureLike;
    const f1 = makeFeature({ loadBucket: 1 }) as FeatureLike;
    expect(routeStyle(f0)).not.toBe(routeStyle(f1));
  });
});
