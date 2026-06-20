/**
 * State-driven coloring (VIZ-03 / Q4).
 *
 * Pre-allocates ONE `Style` per color-ramp bucket at module load so the
 * `StyleFunction`s allocate NOTHING per frame (P10 / T-01-24).
 *
 * Design:
 *  - `HUB_COLORS` + `HUB_BUCKET_LABELS` are the SINGLE source of truth for
 *    both the style cache and the Legend component.
 *  - `hubStyle(feature)` reads `feature.get("volumeBucket")` and returns the
 *    cached `Style` reference for that bucket, or the default for OOB/missing.
 *  - `routeStyle(feature)` reads `feature.get("loadBucket")` similarly.
 *  - Updating a feature's bucket: `feature.set("volumeBucket", b)` → OL
 *    re-invokes the `StyleFunction` on the next render → returns the (already-
 *    allocated) bucket style. NEVER `source.clear()` or `feature.setStyle(new Style(...))`.
 *
 * Exported for the Legend component (same arrays → single source of truth).
 */
import { Style, Fill, Stroke, Circle as CircleStyle } from "ol/style.js";
import type { FeatureLike } from "ol/Feature.js";

// ---------------------------------------------------------------------------
// Hub color ramp (green → red, 5 buckets)
// ---------------------------------------------------------------------------

/**
 * One hex color string per bucket (index 0 = lowest / best). Must match
 * `HUB_BUCKET_LABELS` 1:1. Keep to ≤8 entries so `STYLE_CACHE` stays small.
 */
export const HUB_COLORS: readonly string[] = [
  "#2dc937", // bucket 0 — very low volume / risk
  "#99c140", // bucket 1 — low
  "#e7b416", // bucket 2 — moderate
  "#db7b2b", // bucket 3 — high
  "#cc3232", // bucket 4 — critical
];

/** Display labels for each hub bucket (same index as `HUB_COLORS`). */
export const HUB_BUCKET_LABELS: readonly string[] = [
  "Very low",
  "Low",
  "Moderate",
  "High",
  "Critical",
];

// Pre-allocate ONE Style per bucket — module load, zero per-frame allocation.
const HUB_STYLE_CACHE: readonly Style[] = HUB_COLORS.map(
  (color) =>
    new Style({
      image: new CircleStyle({
        radius: 8,
        fill: new Fill({ color }),
        stroke: new Stroke({ color: "#ffffff", width: 2 }),
      }),
    }),
);

/** Default hub style when the bucket is missing or out of range. */
const HUB_STYLE_DEFAULT = new Style({
  image: new CircleStyle({
    radius: 8,
    fill: new Fill({ color: "#9aa0a6" }),
    stroke: new Stroke({ color: "#ffffff", width: 2 }),
  }),
});

/**
 * Zero-allocation `StyleFunction` for hub features.
 *
 * Reads `feature.get("volumeBucket")` (an integer set via `feature.set`) and
 * returns the corresponding cached `Style` reference. Returns `HUB_STYLE_DEFAULT`
 * for any missing or out-of-range value — no new `Style` ever allocated here.
 */
export function hubStyle(feature: FeatureLike): Style {
  const b: unknown = feature.get("volumeBucket");
  if (typeof b === "number" && b >= 0 && b < HUB_STYLE_CACHE.length) {
    return HUB_STYLE_CACHE[b] as Style;
  }
  return HUB_STYLE_DEFAULT;
}

// ---------------------------------------------------------------------------
// Route color ramp (blue shades — load intensity)
// ---------------------------------------------------------------------------

/**
 * One hex color string per route load bucket (0 = empty, max = overloaded).
 * Must match `ROUTE_BUCKET_LABELS` 1:1.
 */
export const ROUTE_COLORS: readonly string[] = [
  "#dbeafe", // bucket 0 — empty / idle
  "#60a5fa", // bucket 1 — light load
  "#2563eb", // bucket 2 — normal load
  "#1d4ed8", // bucket 3 — heavy load
  "#1e3a8a", // bucket 4 — overloaded
];

/** Display labels for each route bucket. */
export const ROUTE_BUCKET_LABELS: readonly string[] = [
  "Empty",
  "Light",
  "Normal",
  "Heavy",
  "Overloaded",
];

const ROUTE_STYLE_CACHE: readonly Style[] = ROUTE_COLORS.map(
  (color) =>
    new Style({
      stroke: new Stroke({ color, width: 3 }),
    }),
);

const ROUTE_STYLE_DEFAULT = new Style({
  stroke: new Stroke({ color: "#94a3b8", width: 2 }),
});

// ---------------------------------------------------------------------------
// Route SLA-risk overlay (FIX 9 — VIZ-03 completeness)
//
// `slaRiskBucket` (0..3, driven server-side by open exceptions at the leg's
// endpoint hubs) was plumbed onto the feature but never rendered. When a leg is
// at risk (bucket > 0) we draw it in a warm risk ramp (thicker stroke) so the
// SLA-risk signal is visible ON TOP of the load coloring. Bucket 0 = no risk →
// fall through to the normal load style. One pre-allocated Style per risk bucket
// (same zero-per-frame discipline as the load cache).
// ---------------------------------------------------------------------------

/** Warm risk ramp, index = slaRiskBucket (1..3; 0 means "no risk", not styled). */
export const ROUTE_RISK_COLORS: readonly string[] = [
  "#94a3b8", // bucket 0 placeholder (unused — bucket 0 uses the load style)
  "#f59e0b", // bucket 1 — low risk (amber)
  "#ea580c", // bucket 2 — medium risk (orange)
  "#dc2626", // bucket 3 — high risk (red)
];

const ROUTE_RISK_STYLE_CACHE: readonly Style[] = ROUTE_RISK_COLORS.map(
  (color) =>
    new Style({
      // Slightly thicker than the load stroke so an at-risk leg reads as urgent.
      stroke: new Stroke({ color, width: 5 }),
    }),
);

/**
 * Zero-allocation `StyleFunction` for route (LineString) features.
 *
 * FIX 9: an at-risk leg (`slaRiskBucket` > 0) is colored from the warm risk ramp
 * so the SLA-risk signal is visible; otherwise the normal `loadBucket` color is
 * used. Both paths return a pre-allocated cached `Style` (no per-frame alloc).
 */
export function routeStyle(feature: FeatureLike): Style {
  const risk: unknown = feature.get("slaRiskBucket");
  if (
    typeof risk === "number" &&
    risk > 0 &&
    risk < ROUTE_RISK_STYLE_CACHE.length
  ) {
    return ROUTE_RISK_STYLE_CACHE[risk] as Style;
  }
  const b: unknown = feature.get("loadBucket");
  if (typeof b === "number" && b >= 0 && b < ROUTE_STYLE_CACHE.length) {
    return ROUTE_STYLE_CACHE[b] as Style;
  }
  return ROUTE_STYLE_DEFAULT;
}

// ---------------------------------------------------------------------------
// Trailer state coloring (FIX 9 — VIZ-03 completeness)
//
// The in-transit trailer `state` ("onTime" | "slaRisk" | "late" | "idle") was
// set on the feature (`upsertTrailerKeyframe`) but the trailer layer used a
// single static fill, so the state was never visible. `trailerStyle` colors a
// trailer marker by its state from a pre-allocated cache (one Style per state).
// ---------------------------------------------------------------------------

/** One fill color per trailer state (FIX 9). Drives the live trailer markers. */
export const TRAILER_STATE_COLORS: Readonly<Record<string, string>> = {
  onTime: "#16a34a", // green — healthy (matches the prior static marker color)
  slaRisk: "#f59e0b", // amber — flagged by the detector (open exception)
  late: "#dc2626", // red — reserved (no schedule signal in the MVP yet)
  idle: "#9aa0a6", // grey — parked at a hub
};

function makeTrailerStyle(color: string): Style {
  return new Style({
    image: new CircleStyle({
      radius: 5,
      fill: new Fill({ color }),
      stroke: new Stroke({ color: "#ffffff", width: 1.5 }),
    }),
  });
}

// Pre-allocate ONE Style per known state at module load (zero per-frame alloc).
const TRAILER_STYLE_CACHE: ReadonlyMap<string, Style> = new Map(
  Object.entries(TRAILER_STATE_COLORS).map(([state, color]) => [
    state,
    makeTrailerStyle(color),
  ]),
);

/** Default trailer style for an unknown/missing state (grey). */
const TRAILER_STYLE_DEFAULT = makeTrailerStyle("#9aa0a6");

/**
 * Zero-allocation `StyleFunction` for live trailer (Point) features.
 *
 * Reads `feature.get("state")` and returns the cached `Style` for that state, or
 * the default for an unknown/missing state. Mutating a trailer's state via
 * `feature.set("state", s)` re-invokes this on the next render — no new Style.
 */
export function trailerStyle(feature: FeatureLike): Style {
  const state: unknown = feature.get("state");
  if (typeof state === "string") {
    const cached = TRAILER_STYLE_CACHE.get(state);
    if (cached !== undefined) return cached;
  }
  return TRAILER_STYLE_DEFAULT;
}
