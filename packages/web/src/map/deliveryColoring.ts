/**
 * Outbound-delivery marker coloring (VIZ-14 / Phase 22).
 *
 * A `PackageDelivered` ws event flashes a STATIONARY marker at the DESTINATION
 * hub for ~2s (freight exiting the network). This module is the SINGLE source of
 * truth for the delivery StyleFunction (layers.ts) — same discipline as
 * inductionColoring.ts.
 *
 * Zero-per-frame allocation: ONE pre-allocated `Style` at module load; the
 * StyleFunction returns the cached reference (P10 / T-01-24). All delivery markers
 * look identical, so there is no per-kind branching.
 */
import { Style, Fill, Stroke, Circle as CircleStyle, Text } from "ol/style.js";

/** Disc radius (px) for a delivery marker (matches the induction marker). */
const DELIVERY_RADIUS = 14;
const EMOJI_FONT =
  '20px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

/**
 * Green — distinct from induction purple (#7c3aed) and consolidation cyan
 * (#0891b2), and from hub (green/red) and stop (amber/blue) markers. Green signals
 * delivery/success (freight exits the network).
 */
export const DELIVERY_COLOR = "#16a34a";
const DELIVERY_GLYPH = "✓"; // ✓

/** Pre-allocate ONE Style at module load (zero per-frame allocation). */
const DELIVERY_STYLE_DEFAULT = new Style({
  image: new CircleStyle({
    radius: DELIVERY_RADIUS,
    fill: new Fill({ color: DELIVERY_COLOR }),
    stroke: new Stroke({ color: "#ffffff", width: 2 }),
  }),
  text: new Text({ text: DELIVERY_GLYPH, font: EMOJI_FONT }),
});

/**
 * Zero-allocation `StyleFunction` for delivery (Point) features. All delivery
 * markers share one style, so this returns the single cached reference. Takes no
 * argument (structurally compatible with OL's `StyleFunction` signature).
 */
export function deliveryStyle(): Style {
  return DELIVERY_STYLE_DEFAULT;
}
