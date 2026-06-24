/**
 * Parked/refueling truck-STOP coloring (SP2 — spec §8).
 *
 * A trailer at a mid-leg `rested` or `refueling` stop renders a STATIONARY marker
 * (distinct from the moving-trailer markers) for the stop's duration. This module
 * is the SINGLE source of truth for BOTH the stop StyleFunction (layers.ts) and
 * the Legend "Truck status" section — same colors + labels, so the legend can
 * never diverge from the map (same discipline as coloring.ts / dutyColoring.ts).
 *
 * Zero-per-frame allocation: ONE pre-allocated `Style` per stop kind at module
 * load; the StyleFunction returns a cached reference (P10 / T-01-24).
 */
import { Style, Fill, Stroke, Circle as CircleStyle, Text } from "ol/style.js";
import type { FeatureLike } from "ol/Feature.js";

/** The two mid-leg stop kinds the geo-track projection emits. */
export type StopKind = "rested" | "refueling";

/** Disc radius (px) for a parked/refueling marker (slightly larger so it reads as "stopped"). */
const STOP_RADIUS = 15;
const EMOJI_FONT =
  '20px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

/**
 * One color + glyph per stop kind. Amber "P" for a rest (parking) and blue fuel
 * pump for a refuel — chosen to read distinctly from the green moving-truck
 * markers AND from each other.
 */
export const STOP_COLORS: Readonly<Record<StopKind, string>> = {
  rested: "#f59e0b", // amber — parked at a rest area
  refueling: "#2563eb", // blue — refueling
};

const STOP_GLYPHS: Readonly<Record<StopKind, string>> = {
  rested: "🅿️",
  refueling: "⛽",
};

/**
 * The "Truck status" legend rows (index order = display order): the MOVING state
 * plus the two stop kinds. Kept as a flat label list so the Legend renders one row
 * per entry from the same source the map colors by.
 */
export const STOP_STATUS_LABELS: readonly string[] = ["Moving", "Resting", "Refueling"];

/** The colors paired 1:1 with {@link STOP_STATUS_LABELS} for the legend swatches. */
export const STOP_STATUS_COLORS: readonly string[] = [
  "#16a34a", // moving — matches the healthy moving-trailer marker (coloring.ts onTime)
  STOP_COLORS.rested,
  STOP_COLORS.refueling,
];

function makeStopStyle(kind: StopKind): Style {
  return new Style({
    image: new CircleStyle({
      radius: STOP_RADIUS,
      fill: new Fill({ color: STOP_COLORS[kind] }),
      // A thicker white ring so a parked marker reads as "halted" vs a moving truck.
      stroke: new Stroke({ color: "#ffffff", width: 3 }),
    }),
    text: new Text({ text: STOP_GLYPHS[kind], font: EMOJI_FONT }),
  });
}

// Pre-allocate ONE Style per kind at module load (zero per-frame allocation).
const STOP_STYLE_CACHE: ReadonlyMap<string, Style> = new Map([
  ["rested", makeStopStyle("rested")],
  ["refueling", makeStopStyle("refueling")],
]);

/** Default style for an unknown/missing stop kind (grey parked disc). */
const STOP_STYLE_DEFAULT = new Style({
  image: new CircleStyle({
    radius: STOP_RADIUS,
    fill: new Fill({ color: "#9aa0a6" }),
    stroke: new Stroke({ color: "#ffffff", width: 3 }),
  }),
});

/**
 * Zero-allocation `StyleFunction` for stop (Point) features. Reads
 * `feature.get("kind")` and returns the cached `Style` for that kind, or the
 * default. Mutating a feature's kind re-invokes this on the next render.
 */
export function stopStyle(feature: FeatureLike): Style {
  const kind: unknown = feature.get("kind");
  if (typeof kind === "string") {
    const cached = STOP_STYLE_CACHE.get(kind);
    if (cached !== undefined) return cached;
  }
  return STOP_STYLE_DEFAULT;
}

/** Human label for a trailer's status (for tooltips / the legend mapping). */
export function trailerStatusLabelFor(status: "moving" | StopKind): string {
  switch (status) {
    case "rested":
      return "Resting";
    case "refueling":
      return "Refueling";
    default:
      return "Moving";
  }
}
