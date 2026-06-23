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
  class MockText {
    constructor(readonly opts: { text: string; font?: string }) {}
  }
  class MockStyle {
    constructor(
      readonly opts: { image?: MockCircleStyle; stroke?: MockStroke; text?: MockText },
    ) {}
  }
  return {
    Style: MockStyle,
    Fill: MockFill,
    Stroke: MockStroke,
    Circle: MockCircleStyle,
    Text: MockText,
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
  trailerStyle,
  HUB_COLORS,
  HUB_BUCKET_LABELS,
  ROUTE_COLORS,
  ROUTE_BUCKET_LABELS,
  HUB_EMOJI,
  TRAILER_EMOJI,
  TRAILER_STATE_COLORS,
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
// VIZ-11: hubStyle prefers the driver-DUTY bucket when present, falling back to
// the VOLUME bucket otherwise (so existing volume-only features are unchanged).
// ---------------------------------------------------------------------------

describe("hubStyle (VIZ-11 driver-duty coloring)", () => {
  it("colors a hub by its dutyBucket when set (NOT the volume style)", async () => {
    const { DUTY_COLORS } = await import("./dutyColoring.js");
    // Same volumeBucket, but dutyBucket present → must NOT collapse to the volume
    // style (otherwise the driver-availability signal is invisible on the map).
    const volumeOnly = makeFeature({ volumeBucket: 1 }) as FeatureLike;
    const withDuty = makeFeature({ volumeBucket: 1, dutyBucket: 3 }) as FeatureLike;
    expect(hubStyle(withDuty)).not.toBe(hubStyle(volumeOnly));
    // And the disc fill tracks the duty color, not the volume color.
    const s = shape(hubStyle(withDuty));
    expect(s.opts.image?.opts.fill.opts.color).toBe(DUTY_COLORS[3]);
  });

  it("returns the same cached duty Style ref for the same dutyBucket (zero alloc)", () => {
    const f = makeFeature({ volumeBucket: 0, dutyBucket: 2 }) as FeatureLike;
    expect(hubStyle(f)).toBe(hubStyle(f));
  });

  it("distinct dutyBuckets → distinct cached styles", () => {
    const a = makeFeature({ dutyBucket: 0 }) as FeatureLike;
    const b = makeFeature({ dutyBucket: 3 }) as FeatureLike;
    expect(hubStyle(a)).not.toBe(hubStyle(b));
  });

  it("falls back to the volume style when dutyBucket is out of range", () => {
    const oob = makeFeature({ volumeBucket: 2, dutyBucket: 999 }) as FeatureLike;
    const volumeOnly = makeFeature({ volumeBucket: 2 }) as FeatureLike;
    expect(hubStyle(oob)).toBe(hubStyle(volumeOnly));
  });

  it("still renders the hub emoji on the duty-colored disc", () => {
    const s = shape(hubStyle(makeFeature({ dutyBucket: 1 }) as FeatureLike));
    expect(s.opts.text?.opts.text).toBe(HUB_EMOJI);
    expect(s.opts.image?.opts.radius).toBe(16);
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

  // FIX 9 (VIZ-03 completeness): route slaRiskBucket must now drive coloring.
  // It was plumbed onto the feature but routeStyle ignored it (dark on the map).
  it("FIX 9: a route with slaRiskBucket > 0 renders a DIFFERENT style than load-only", () => {
    // Same loadBucket, but one is flagged at-risk → must NOT collapse to the same
    // style (otherwise the SLA-risk signal is invisible on the map).
    const loadOnly = makeFeature({ loadBucket: 1, slaRiskBucket: 0 }) as FeatureLike;
    const atRisk = makeFeature({ loadBucket: 1, slaRiskBucket: 3 }) as FeatureLike;
    expect(routeStyle(atRisk)).not.toBe(routeStyle(loadOnly));
  });

  it("FIX 9: same slaRiskBucket → same cached style (zero per-frame allocation)", () => {
    const f = makeFeature({ loadBucket: 2, slaRiskBucket: 2 }) as FeatureLike;
    expect(routeStyle(f)).toBe(routeStyle(f));
  });
});

// ---------------------------------------------------------------------------
// FIX 9 — trailerStyle: state-driven coloring (was a single static style).
// The in-transit trailer `state` ("onTime" | "slaRisk" | "late" | "idle") was
// set on the feature but never rendered. trailerStyle must color by state.
// ---------------------------------------------------------------------------

describe("trailerStyle (FIX 9 — state-driven trailer coloring)", () => {
  it("returns the same cached ref for the same state (zero alloc)", () => {
    const f = makeFeature({ state: "onTime" }) as FeatureLike;
    expect(trailerStyle(f)).toBe(trailerStyle(f));
  });

  it("renders an at-risk trailer DIFFERENTLY than an on-time one", () => {
    const onTime = makeFeature({ state: "onTime" }) as FeatureLike;
    const atRisk = makeFeature({ state: "slaRisk" }) as FeatureLike;
    expect(trailerStyle(atRisk)).not.toBe(trailerStyle(onTime));
  });

  it("falls back to a default style for an unknown/missing state", () => {
    const missing = makeFeature({}) as FeatureLike;
    const unknown = makeFeature({ state: "bogus" }) as FeatureLike;
    expect(trailerStyle(missing)).toBe(trailerStyle(unknown));
  });
});

// ---------------------------------------------------------------------------
// Emoji markers: hubs render 🏭 and trailers render 🚛 ON a colored disc (the
// disc keeps the volume/state color encoding + the click hit-area; the emoji
// adds at-a-glance identity). Glyphs are single-source-of-truth constants.
// ---------------------------------------------------------------------------

interface StyleShape {
  opts: {
    image?: { opts: { radius: number; fill: { opts: { color: string } } } };
    text?: { opts: { text: string } };
  };
}
function shape(s: unknown): StyleShape {
  return s as StyleShape;
}

describe("emoji markers (hubs 🏭 / trailers 🚛)", () => {
  it("exports non-empty emoji glyph constants", () => {
    expect(typeof HUB_EMOJI).toBe("string");
    expect(HUB_EMOJI.length).toBeGreaterThan(0);
    expect(typeof TRAILER_EMOJI).toBe("string");
    expect(TRAILER_EMOJI.length).toBeGreaterThan(0);
  });

  it("hubStyle renders the hub emoji on a size-16 volume-colored disc (every bucket)", () => {
    for (let b = 0; b < HUB_COLORS.length; b++) {
      const s = shape(hubStyle(makeFeature({ volumeBucket: b }) as FeatureLike));
      expect(s.opts.text?.opts.text).toBe(HUB_EMOJI);
      // Color encoding preserved: the disc fill still tracks the volume bucket.
      expect(s.opts.image?.opts.fill.opts.color).toBe(HUB_COLORS[b]);
      // Disc radius is 16 per the sizing spec.
      expect(s.opts.image?.opts.radius).toBe(16);
    }
  });

  it("trailerStyle renders the trailer emoji on a size-16 state-colored disc", () => {
    const s = shape(trailerStyle(makeFeature({ state: "onTime" }) as FeatureLike));
    expect(s.opts.text?.opts.text).toBe(TRAILER_EMOJI);
    expect(s.opts.image?.opts.fill.opts.color).toBe(TRAILER_STATE_COLORS.onTime);
    expect(s.opts.image?.opts.radius).toBe(16);
  });
});
