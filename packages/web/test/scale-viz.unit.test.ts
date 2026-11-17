/**
 * VIZ-15/16 scale visualization unit tests.
 *
 * Asserts:
 *  - hubStyleTiered returns the correct tier-branch cached Style refs (center vs spoke)
 *    while preserving the volume-bucket fill within each tier.
 *  - routeStyleTiered returns the heavy backbone style for isBackbone=true and the
 *    spoke-leg style for isBackbone=false, both as pre-allocated cached references.
 *  - No new Style is allocated inside the style functions (identity equality check).
 *  - Legend tier arrays have correct lengths and non-empty string entries.
 *
 * OL Style/Fill/Stroke/CircleStyle are mocked so the test runs in Node env
 * (same pattern as coloring.test.ts — no browser needed for cached-style logic).
 */
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock OL style modules before importing the module under test.
// ---------------------------------------------------------------------------

vi.mock("ol/style.js", () => {
  class MockFill {
    constructor(readonly opts: { color: string }) {}
  }
  class MockStroke {
    constructor(readonly opts: { color: string; width: number }) {}
  }
  class MockCircleStyle {
    constructor(
      readonly opts: { radius: number; fill: MockFill; stroke?: MockStroke },
    ) {}
  }
  class MockText {
    constructor(readonly opts: { text: string; font?: string }) {}
  }
  class MockStyle {
    constructor(
      readonly opts: {
        image?: MockCircleStyle;
        stroke?: MockStroke;
        text?: MockText;
        opacity?: number;
      },
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

// Minimal FeatureLike mock with a get() method.
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
  hubStyleTiered,
  routeStyleTiered,
  HUB_COLORS,
  HUB_TIER_LABELS,
  HUB_TIER_RING_COLORS,
  LEG_TIER_LABELS,
  LEG_TIER_COLORS,
  CENTER_MARKER_RADIUS,
  SPOKE_MARKER_RADIUS,
  BACKBONE_LEG_COLOR,
  CENTER_RING_COLOR,
} from "../src/map/coloring.js";
import type { FeatureLike } from "ol/Feature.js";

// Helper: narrow the opaque Style to its mock shape for assertions.
interface StyleShape {
  opts: {
    image?: { opts: { radius: number; fill: { opts: { color: string } }; stroke?: { opts: { color: string; width: number } } } };
    stroke?: { opts: { color: string; width: number } };
    text?: { opts: { text: string } };
    opacity?: number;
  };
}
function shape(s: unknown): StyleShape {
  return s as StyleShape;
}

// ---------------------------------------------------------------------------
// VIZ-16 — hubStyleTiered: center tier (kind="center")
// ---------------------------------------------------------------------------

describe("hubStyleTiered — center tier", () => {
  it("returns the center-tier cached Style for kind=center + volumeBucket=0 (zero alloc)", () => {
    const f = makeFeature({ kind: "center", volumeBucket: 0 }) as FeatureLike;
    const r1 = hubStyleTiered(f);
    const r2 = hubStyleTiered(f);
    expect(r1).toBe(r2); // same pre-allocated ref — no per-call allocation
  });

  it("center-tier style has radius CENTER_MARKER_RADIUS (20px)", () => {
    const f = makeFeature({ kind: "center", volumeBucket: 0 }) as FeatureLike;
    const s = shape(hubStyleTiered(f));
    expect(s.opts.image?.opts.radius).toBe(CENTER_MARKER_RADIUS);
    expect(CENTER_MARKER_RADIUS).toBe(20);
  });

  it("center-tier style has the amber CENTER_RING_COLOR (#f59e0b) stroke", () => {
    const f = makeFeature({ kind: "center", volumeBucket: 0 }) as FeatureLike;
    const s = shape(hubStyleTiered(f));
    expect(s.opts.image?.opts.stroke?.opts.color).toBe(CENTER_RING_COLOR);
    expect(CENTER_RING_COLOR).toBe("#f59e0b");
  });

  it("center-tier preserves the volume-bucket fill color (tier ≠ hue, hue owned by ramp)", () => {
    for (let b = 0; b < HUB_COLORS.length; b++) {
      const f = makeFeature({ kind: "center", volumeBucket: b }) as FeatureLike;
      const s = shape(hubStyleTiered(f));
      expect(s.opts.image?.opts.fill.opts.color).toBe(HUB_COLORS[b]);
    }
  });

  it("distinct center-tier volume buckets → distinct cached style refs", () => {
    const f0 = makeFeature({ kind: "center", volumeBucket: 0 }) as FeatureLike;
    const f1 = makeFeature({ kind: "center", volumeBucket: 1 }) as FeatureLike;
    expect(hubStyleTiered(f0)).not.toBe(hubStyleTiered(f1));
  });

  it("center-tier style is DISTINCT from spoke-tier style for the same bucket", () => {
    const center = makeFeature({ kind: "center", volumeBucket: 0 }) as FeatureLike;
    const spoke = makeFeature({ kind: "spoke", volumeBucket: 0 }) as FeatureLike;
    expect(hubStyleTiered(center)).not.toBe(hubStyleTiered(spoke));
  });
});

// ---------------------------------------------------------------------------
// VIZ-16 — hubStyleTiered: spoke tier (kind="spoke")
// ---------------------------------------------------------------------------

describe("hubStyleTiered — spoke tier", () => {
  it("returns the spoke-tier cached Style for kind=spoke + volumeBucket=0 (zero alloc)", () => {
    const f = makeFeature({ kind: "spoke", volumeBucket: 0 }) as FeatureLike;
    expect(hubStyleTiered(f)).toBe(hubStyleTiered(f));
  });

  it("spoke-tier style has radius SPOKE_MARKER_RADIUS (12px)", () => {
    const f = makeFeature({ kind: "spoke", volumeBucket: 0 }) as FeatureLike;
    const s = shape(hubStyleTiered(f));
    expect(s.opts.image?.opts.radius).toBe(SPOKE_MARKER_RADIUS);
    expect(SPOKE_MARKER_RADIUS).toBe(12);
  });

  it("spoke-tier style has a white (#ffffff) stroke ring", () => {
    const f = makeFeature({ kind: "spoke", volumeBucket: 0 }) as FeatureLike;
    const s = shape(hubStyleTiered(f));
    expect(s.opts.image?.opts.stroke?.opts.color).toBe("#ffffff");
  });

  it("spoke-tier preserves the volume-bucket fill color", () => {
    for (let b = 0; b < HUB_COLORS.length; b++) {
      const f = makeFeature({ kind: "spoke", volumeBucket: b }) as FeatureLike;
      const s = shape(hubStyleTiered(f));
      expect(s.opts.image?.opts.fill.opts.color).toBe(HUB_COLORS[b]);
    }
  });

  it("distinct spoke-tier volume buckets → distinct cached style refs", () => {
    const f0 = makeFeature({ kind: "spoke", volumeBucket: 0 }) as FeatureLike;
    const f1 = makeFeature({ kind: "spoke", volumeBucket: 1 }) as FeatureLike;
    expect(hubStyleTiered(f0)).not.toBe(hubStyleTiered(f1));
  });
});

// ---------------------------------------------------------------------------
// VIZ-16 — hubStyleTiered: legacy fallback (no kind set)
// ---------------------------------------------------------------------------

describe("hubStyleTiered — legacy fallback", () => {
  it("falls through to base hubStyle when kind is absent", () => {
    const withoutKind = makeFeature({ volumeBucket: 0 }) as FeatureLike;
    const s = shape(hubStyleTiered(withoutKind));
    // Base hubStyle uses MARKER_RADIUS (16), not 20 or 12.
    expect(s.opts.image?.opts.radius).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// VIZ-16 — routeStyleTiered: backbone leg (isBackbone=true)
// ---------------------------------------------------------------------------

describe("routeStyleTiered — backbone leg", () => {
  it("returns the pre-allocated backbone Style for isBackbone=true (zero alloc)", () => {
    const f = makeFeature({ isBackbone: true }) as FeatureLike;
    expect(routeStyleTiered(f)).toBe(routeStyleTiered(f));
  });

  it("backbone style stroke color contains BACKBONE_LEG_COLOR channel (#cbd5e1)", () => {
    const f = makeFeature({ isBackbone: true }) as FeatureLike;
    const s = shape(routeStyleTiered(f));
    // The style encodes opacity in the color channel as rgba(..., 0.9) rather than
    // using a top-level `opacity` property (OL 10 Style has no opacity option).
    // Assert that the color contains the BACKBONE_LEG_COLOR channel components.
    const color = s.opts.stroke?.opts.color ?? "";
    // Either the raw hex or an rgba encoding of it is acceptable.
    expect(
      color === BACKBONE_LEG_COLOR ||
        /rgba?\(203,\s*213,\s*225/.test(color),
    ).toBe(true);
    expect(BACKBONE_LEG_COLOR).toBe("#cbd5e1");
  });

  it("backbone style has stroke width 4", () => {
    const f = makeFeature({ isBackbone: true }) as FeatureLike;
    const s = shape(routeStyleTiered(f));
    expect(s.opts.stroke?.opts.width).toBe(4);
  });

  it("backbone and spoke-leg style refs are distinct (different tiers)", () => {
    const backbone = makeFeature({ isBackbone: true }) as FeatureLike;
    const spoke = makeFeature({ isBackbone: false }) as FeatureLike;
    expect(routeStyleTiered(backbone)).not.toBe(routeStyleTiered(spoke));
  });
});

// ---------------------------------------------------------------------------
// VIZ-16 — routeStyleTiered: spoke leg (isBackbone=false)
// ---------------------------------------------------------------------------

describe("routeStyleTiered — spoke leg", () => {
  it("returns the pre-allocated spoke-leg Style for isBackbone=false (zero alloc)", () => {
    const f = makeFeature({ isBackbone: false }) as FeatureLike;
    expect(routeStyleTiered(f)).toBe(routeStyleTiered(f));
  });

  it("spoke-leg style has stroke width 2", () => {
    const f = makeFeature({ isBackbone: false }) as FeatureLike;
    const s = shape(routeStyleTiered(f));
    expect(s.opts.stroke?.opts.width).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// VIZ-16 — Legend tier arrays (single source of truth)
// ---------------------------------------------------------------------------

describe("legend tier arrays", () => {
  it("HUB_TIER_LABELS has 2 entries (center, spoke)", () => {
    expect(HUB_TIER_LABELS.length).toBe(2);
    expect(HUB_TIER_LABELS[0]).toBe("Regional center");
    expect(HUB_TIER_LABELS[1]).toBe("Spoke hub");
  });

  it("HUB_TIER_RING_COLORS matches HUB_TIER_LABELS length", () => {
    expect(HUB_TIER_RING_COLORS.length).toBe(HUB_TIER_LABELS.length);
  });

  it("HUB_TIER_RING_COLORS[0] is the amber center ring (#f59e0b)", () => {
    expect(HUB_TIER_RING_COLORS[0]).toBe(CENTER_RING_COLOR);
  });

  it("LEG_TIER_LABELS has 2 entries (Backbone, Spoke leg)", () => {
    expect(LEG_TIER_LABELS.length).toBe(2);
    expect(LEG_TIER_LABELS[0]).toBe("Backbone");
    expect(LEG_TIER_LABELS[1]).toBe("Spoke leg");
  });

  it("LEG_TIER_COLORS matches LEG_TIER_LABELS length", () => {
    expect(LEG_TIER_COLORS.length).toBe(LEG_TIER_LABELS.length);
  });

  it("LEG_TIER_COLORS[0] is the backbone color (#cbd5e1)", () => {
    expect(LEG_TIER_COLORS[0]).toBe(BACKBONE_LEG_COLOR);
  });

  it("all tier label strings are non-empty", () => {
    for (const label of [...HUB_TIER_LABELS, ...LEG_TIER_LABELS]) {
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
