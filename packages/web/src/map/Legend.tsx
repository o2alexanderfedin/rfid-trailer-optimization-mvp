/**
 * Legend component (VIZ-03 / Q4 / frontend-design skill).
 *
 * Renders a clean, legible color ramp legend derived from the SAME
 * `COLORS` / `LABELS` arrays used to build the `STYLE_CACHE` in coloring.ts
 * — a single source of truth so the legend can never diverge from the map
 * rendering.
 *
 * Design principles (frontend-design skill):
 *  - Compact: positioned over the map, not above it (map stays full-height).
 *  - Clear contrast: white background + drop shadow over the basemap.
 *  - Spacing: 8px row gap, 10px swatch, 4px between swatch and label.
 *  - Typography: 11px / 600 weight headings, 11px labels — readable but small.
 *  - No per-frame React re-render: the legend is static once mounted (bucket
 *    definitions don't change at runtime); only `activeMetric` prop changes.
 */

import {
  HUB_COLORS,
  HUB_BUCKET_LABELS,
  ROUTE_COLORS,
  ROUTE_BUCKET_LABELS,
  HUB_TIER_LABELS,
  HUB_TIER_RING_COLORS,
  LEG_TIER_LABELS,
  LEG_TIER_COLORS,
} from "./coloring.js";
import { DUTY_COLORS, DUTY_BUCKET_LABELS } from "./dutyColoring.js";
import { STOP_STATUS_COLORS, STOP_STATUS_LABELS } from "./stopColoring.js";

/** Which metric the hub layer currently displays. */
export type HubMetric = "volume" | "slaRisk" | "congestion";
/** Which metric the route layer currently displays. */
export type RouteMetric = "load" | "slaRisk";

interface LegendProps {
  /** Which hub metric bucket the coloring represents. */
  readonly hubMetric?: HubMetric;
  /** Which route metric bucket the coloring represents. */
  readonly routeMetric?: RouteMetric;
}

const HUB_METRIC_LABELS: Record<HubMetric, string> = {
  volume: "Hub volume",
  slaRisk: "Hub SLA risk",
  congestion: "Hub congestion",
};

const ROUTE_METRIC_LABELS: Record<RouteMetric, string> = {
  load: "Route load",
  slaRisk: "Route SLA risk",
};

/**
 * Inline styles (no CSS file needed — keeps the component self-contained and
 * avoids a separate stylesheet import that Playwright would need to serve).
 */
const styles = {
  container: {
    position: "absolute" as const,
    bottom: 24,
    right: 12,
    background: "rgba(255, 255, 255, 0.95)",
    borderRadius: 6,
    boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
    padding: "10px 14px",
    zIndex: 1000,
    minWidth: 140,
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: 11,
    lineHeight: 1.4,
  },
  section: {
    marginBottom: 10,
  },
  sectionLast: {
    marginBottom: 0,
  },
  heading: {
    fontWeight: 600 as const,
    fontSize: 11,
    letterSpacing: 0.3,
    color: "#374151",
    marginBottom: 5,
    textTransform: "uppercase" as const,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginBottom: 3,
  },
  swatch: {
    width: 10,
    height: 10,
    borderRadius: 2,
    flexShrink: 0,
    border: "1px solid rgba(0,0,0,0.08)",
  },
  label: {
    color: "#4b5563",
  },
  divider: {
    height: 1,
    background: "#e5e7eb",
    margin: "8px 0",
  },
} as const;

/** A reusable color ramp section within the legend. */
function LegendSection({
  title,
  colors,
  labels,
  isLast,
}: {
  title: string;
  colors: readonly string[];
  labels: readonly string[];
  isLast?: boolean;
}): React.JSX.Element {
  return (
    <div style={isLast ? styles.sectionLast : styles.section}>
      <div style={styles.heading}>{title}</div>
      {colors.map((color, i) => (
        <div key={color} style={styles.row}>
          <span
            style={{ ...styles.swatch, background: color }}
            aria-hidden="true"
          />
          <span style={styles.label}>{labels[i] ?? ""}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Map legend showing hub and route color ramps.
 *
 * Rendered as an overlay on the map container (position: absolute).
 * The parent container must have `position: relative` (MapView's `.app__map`
 * already satisfies this via the OL map CSS).
 */
export function Legend({
  hubMetric = "volume",
  routeMetric = "load",
}: LegendProps): React.JSX.Element {
  return (
    <div style={styles.container} data-testid="map-legend" role="complementary" aria-label="Map legend">
      <LegendSection
        title={HUB_METRIC_LABELS[hubMetric]}
        colors={HUB_COLORS}
        labels={HUB_BUCKET_LABELS}
      />
      <div style={styles.divider} role="separator" />
      {/* VIZ-11: driver-duty ramp — hub markers color by driver availability when
          driver data is present (the v1.2 demo payoff), else by volume above. */}
      <LegendSection
        title="Driver duty"
        colors={DUTY_COLORS}
        labels={DUTY_BUCKET_LABELS}
      />
      <div style={styles.divider} role="separator" />
      {/* SP2 (spec §8): the truck-status ramp — moving vs the parked/refueling
          mid-leg stops, so an operator can read the stationary stop markers. */}
      <LegendSection
        title="Truck status"
        colors={STOP_STATUS_COLORS}
        labels={STOP_STATUS_LABELS}
      />
      <div style={styles.divider} role="separator" />
      {/* VIZ-16: hub tier hierarchy — Regional center (large amber ring) vs Spoke hub (small).
          Derived from the HUB_TIER_LABELS/HUB_TIER_RING_COLORS single source of truth used
          by hubStyleTiered (size + ring, NOT hue — hue belongs to the volume ramp above). */}
      <LegendSection
        title="Hub tier"
        colors={HUB_TIER_RING_COLORS}
        labels={HUB_TIER_LABELS}
      />
      <div style={styles.divider} role="separator" />
      {/* VIZ-16: route tier — backbone inter-center legs (heavy) vs spoke legs (light). */}
      <LegendSection
        title="Route tier"
        colors={LEG_TIER_COLORS}
        labels={LEG_TIER_LABELS}
      />
      <div style={styles.divider} role="separator" />
      <LegendSection
        title={ROUTE_METRIC_LABELS[routeMetric]}
        colors={ROUTE_COLORS}
        labels={ROUTE_BUCKET_LABELS}
        isLast
      />
    </div>
  );
}
