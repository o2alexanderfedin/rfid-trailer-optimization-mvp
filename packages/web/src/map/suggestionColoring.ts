/**
 * Advisory-suggestion marker coloring (VIZ-17).
 *
 * A `SuggestionEvent` ws tick-field flashes a transient marker at the
 * suggestion target hub for ~2500ms: green (accepted) or red (rejected).
 * This module is the SINGLE source of truth for the two suggestion
 * `StyleFunction`s (layers.ts) — same discipline as `inductionColoring.ts`.
 *
 * Zero-per-frame allocation: TWO pre-allocated `Style`s at module load (one
 * per outcome); `suggestionStyle` returns the cached reference by `outcome`
 * feature prop. All suggestion markers are circles of the same shape; only
 * the fill color and glyph differ per outcome (accept vs reject).
 *
 * Per UI-SPEC VIZ-17:
 *  - radius 13px (between induction 14 and spoke 12)
 *  - accept fill #16a34a (green), glyph ✓
 *  - reject fill #dc2626 (red), glyph ✕
 *  - white 2px stroke
 */
import { Style, Fill, Stroke, Circle as CircleStyle, Text } from "ol/style.js";
import type { FeatureLike } from "ol/Feature.js";

/** Disc radius (px) for a suggestion marker (between induction 14 and spoke 12). */
const SUGGESTION_RADIUS = 13;
const EMOJI_FONT =
  '20px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

/** Accept: green fill (#16a34a), glyph ✓. */
const SUGGESTION_ACCEPT_STYLE = new Style({
  image: new CircleStyle({
    radius: SUGGESTION_RADIUS,
    fill: new Fill({ color: "#16a34a" }),
    stroke: new Stroke({ color: "#ffffff", width: 2 }),
  }),
  text: new Text({ text: "✓", font: EMOJI_FONT }),
});

/** Reject: red fill (#dc2626), glyph ✕. */
const SUGGESTION_REJECT_STYLE = new Style({
  image: new CircleStyle({
    radius: SUGGESTION_RADIUS,
    fill: new Fill({ color: "#dc2626" }),
    stroke: new Stroke({ color: "#ffffff", width: 2 }),
  }),
  text: new Text({ text: "✕", font: EMOJI_FONT }),
});

/**
 * Zero-allocation `StyleFunction` for suggestion (Point) features. Branches on
 * the `outcome` feature property (`"accepted"` | `"rejected"`), returning the
 * corresponding pre-allocated cached `Style`. Falls back to the reject style for
 * unknown outcome values (safe default for unknown/future values).
 */
export function suggestionStyle(feature: FeatureLike): Style {
  const outcome = feature.get("outcome") as string | undefined;
  return outcome === "accepted" ? SUGGESTION_ACCEPT_STYLE : SUGGESTION_REJECT_STYLE;
}
