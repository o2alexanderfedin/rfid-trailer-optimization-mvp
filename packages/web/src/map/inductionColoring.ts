/**
 * External-induction marker coloring (VIZ-13 / v2.0).
 *
 * A `PackageInducted` ws event flashes a STATIONARY pulsing marker at the spoke
 * hub for ~2s (freight entering the network from outside). This module is the
 * SINGLE source of truth for the induction StyleFunction (layers.ts) — same
 * discipline as stopColoring.ts.
 *
 * Zero-per-frame allocation: ONE pre-allocated `Style` at module load; the
 * StyleFunction returns the cached reference (P10 / T-01-24). All induction
 * markers look identical, so there is no per-kind branching.
 */
import { Style, Fill, Stroke, Circle as CircleStyle, Text } from "ol/style.js";

/** Disc radius (px) for an induction marker (slightly smaller than a stop marker). */
const INDUCTION_RADIUS = 14;
const EMOJI_FONT =
  '20px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

/** Purple — distinct from hub (green/red) and stop (amber/blue) markers. */
export const INDUCTION_COLOR = "#7c3aed";
const INDUCTION_GLYPH = "+";

/** Pre-allocate ONE Style at module load (zero per-frame allocation). */
const INDUCTION_STYLE_DEFAULT = new Style({
  image: new CircleStyle({
    radius: INDUCTION_RADIUS,
    fill: new Fill({ color: INDUCTION_COLOR }),
    stroke: new Stroke({ color: "#ffffff", width: 2 }),
  }),
  text: new Text({ text: INDUCTION_GLYPH, font: EMOJI_FONT }),
});

/**
 * Zero-allocation `StyleFunction` for induction (Point) features. All induction
 * markers share one style, so this returns the single cached reference. Takes no
 * argument (structurally compatible with OL's `StyleFunction` signature).
 */
export function inductionStyle(): Style {
  return INDUCTION_STYLE_DEFAULT;
}
