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
  const b = feature.get("volumeBucket");
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

/**
 * Zero-allocation `StyleFunction` for route (LineString) features.
 *
 * Reads `feature.get("loadBucket")` and returns the cached stroke style.
 */
export function routeStyle(feature: FeatureLike): Style {
  const b = feature.get("loadBucket");
  if (typeof b === "number" && b >= 0 && b < ROUTE_STYLE_CACHE.length) {
    return ROUTE_STYLE_CACHE[b] as Style;
  }
  return ROUTE_STYLE_DEFAULT;
}
