import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hub, LogNormalParams, LonLat, Route } from "@mm/domain";
import { transitParamsForLeg } from "@mm/domain";

// v1.1 Phase-7 (OPT-09): the pure geography→transit derivation (`haversineKm`,
// `transitParamsForLeg`) MOVED to `@mm/domain` so the optimizer — which cannot
// import `@mm/simulation` — shares ONE source of truth. We re-import + re-export
// them here so this module's behavior (and the golden-replay keystone) is
// byte-identical to v1.0; `buildTransitParamsByLeg` stays sim-side (it keys by
// the sim's `routeId`) but now derives each leg via the domain helper.
export { haversineKm, transitParamsForLeg } from "@mm/domain";

/**
 * SIM-01: great-circle linehaul routes over the USA hub network.
 *
 * `greatCircle` interpolates the shortest-path arc between two WGS84 points
 * using spherical (slerp) interpolation, returning `[lon, lat]` GeoJSON-axis
 * positions that drop straight into OpenLayers (VIZ-01). It is a PURE function
 * (no clock, no RNG), so route geometry is byte-identical across runs.
 *
 * `buildRoutes` lays out a hub-and-spoke topology centered on the first hub
 * (Memphis), the classic middle-mile design: every spoke hub has a linehaul leg
 * to/from the center, so the graph is connected and every hub is reachable.
 */

const DEG = Math.PI / 180;

/** Convert a `[lon, lat]` (degrees) to a 3D unit vector on the sphere. */
function toVec3(lon: number, lat: number): [number, number, number] {
  const lonR = lon * DEG;
  const latR = lat * DEG;
  const cosLat = Math.cos(latR);
  return [cosLat * Math.cos(lonR), cosLat * Math.sin(lonR), Math.sin(latR)];
}

/** Convert a 3D unit vector back to `[lon, lat]` in degrees. */
function toLonLat(v: readonly [number, number, number]): LonLat {
  const lat = Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG;
  const lon = Math.atan2(v[1], v[0]) / DEG;
  return [lon, lat];
}

/**
 * `n` points along the great-circle arc from `a` to `b`, inclusive of both
 * endpoints. For `n === 1` returns `[a]`. Endpoints are returned EXACTLY (not
 * round-tripped through the sphere) so geometry anchors precisely at hub
 * coordinates. Intermediate points use spherical linear interpolation (slerp);
 * if `a` and `b` are (numerically) coincident, falls back to linear interp.
 */
export function greatCircle(a: LonLat, b: LonLat, n: number): LonLat[] {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`greatCircle: n must be an integer >= 1, got ${n}`);
  }
  if (n === 1) return [[a[0], a[1]]];

  const va = toVec3(a[0], a[1]);
  const vb = toVec3(b[0], b[1]);
  const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);

  const points: LonLat[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    if (i === 0) {
      points.push([a[0], a[1]]); // exact start
      continue;
    }
    if (i === n - 1) {
      points.push([b[0], b[1]]); // exact end
      continue;
    }
    // slerp: (sin((1-t)ω)·a + sin(tω)·b) / sin(ω). Near-zero ω -> linear.
    const k0 = sinOmega < 1e-9 ? 1 - t : Math.sin((1 - t) * omega) / sinOmega;
    const k1 = sinOmega < 1e-9 ? t : Math.sin(t * omega) / sinOmega;
    points.push(
      toLonLat([
        k0 * va[0] + k1 * vb[0],
        k0 * va[1] + k1 * vb[1],
        k0 * va[2] + k1 * vb[2],
      ]),
    );
  }
  return points;
}

/** Number of interpolated vertices per linehaul leg (smooth map arcs). */
const ROUTE_POINTS = 24;

/** Deterministic, stable route id for a directed leg. */
export function routeId(fromHubId: string, toHubId: string): string {
  return `route-${fromHubId}-${toHubId}`;
}

// --- TIME-01: distance-derived per-leg transit ------------------------------
//
// `haversineKm` and `transitParamsForLeg` now live in `@mm/domain` (re-imported
// + re-exported at the top of this module) so the optimizer can share them. The
// hub-and-spoke leg-map builder below stays here because it keys by the sim's
// `routeId`; it derives each leg through the domain `transitParamsForLeg`, so
// behavior is byte-identical to v1.0.

/**
 * VIZ-06 / TIME-01 upgrade — derive a leg's transit {@link LogNormalParams} from
 * the ORS road `duration_s` (the SAME drive time the displayed real-road polyline
 * is based on). The MEDIAN is `duration_s / 60` minutes; `sigma` + the clamp band
 * scaling are IDENTICAL to {@link transitParamsForLeg} (`min = max(5, round(
 * median·0.4))`, `max = round(median·3)`), so only the median source differs.
 * Pure: a function of `(durationSeconds, sigma)` only.
 */
export function transitParamsFromDuration(
  durationSeconds: number,
  sigma: number,
): LogNormalParams {
  const median = durationSeconds / 60;
  return {
    median,
    sigma,
    min: Math.max(5, Math.round(median * 0.4)),
    max: Math.round(median * 3),
  };
}

/**
 * Build the per-directed-leg transit params for a hub-and-spoke network, keyed
 * by the directed {@link routeId} (`route-<from>-<to>`). Mirrors
 * {@link buildRoutes}: the first hub is the center; every spoke gets a directed
 * pair (center→spoke and spoke→center).
 *
 * VIZ-06 / TIME-01 upgrade — each leg's transit MEDIAN now PREFERS the loaded
 * road file's ORS `duration_s` (`duration_s / 60` min, via
 * {@link transitParamsFromDuration}) so the drawn transit matches the displayed
 * real-road polyline. When the file is absent, the leg is missing, or it carries
 * no `duration_s`, the leg FALLS BACK to {@link transitParamsForLeg} (the pure
 * haversine estimate). `sigma` (config) and the median-scaled clamp are shared
 * across both paths. The road source defaults to the committed static file via
 * {@link loadStaticRoadGeometry} (injectable for tests). Pure + deterministic:
 * the static file is committed (no clock, no RNG, no network).
 */
export function buildTransitParamsByLeg(
  hubs: readonly Hub[],
  sigma: number,
  geometry?: RoadGeometryFile,
): Map<string, LogNormalParams> {
  const byLeg = new Map<string, LogNormalParams>();
  if (hubs.length < 2) return byLeg;
  const file = geometry ?? loadStaticRoadGeometry();
  // For one directed leg: ORS `duration_s` median if the file carries it, else
  // the haversine-derived params (deterministic fallback).
  const paramsForLeg = (from: Hub, to: Hub): LogNormalParams => {
    const ors = file?.legs[routeId(from.hubId, to.hubId)]?.duration_s;
    return ors !== undefined
      ? transitParamsFromDuration(ors, sigma)
      : transitParamsForLeg(from, to, sigma);
  };
  const center = hubs[0]!;
  for (let i = 1; i < hubs.length; i += 1) {
    const spoke = hubs[i]!;
    byLeg.set(routeId(center.hubId, spoke.hubId), paramsForLeg(center, spoke));
    byLeg.set(routeId(spoke.hubId, center.hubId), paramsForLeg(spoke, center));
  }
  return byLeg;
}

// --- VIZ-06: loadable road-following geometry (great-circle FALLBACK) --------

/**
 * One directed leg's precomputed ROAD geometry, as written by the offline
 * `scripts/precompute-routes.ts` (OpenRouteService `driving-hgv`). `geometry` is
 * a `[lon, lat][]` LineString (GeoJSON axis order); `distance_m` / `duration_s`
 * carry the ORS `summary` for reference / a future speed-based transit estimate.
 */
export interface RoadLeg {
  /** Road-snapped `[lon, lat]` LineString for this directed leg. */
  readonly geometry: readonly LonLat[];
  /** ORS `summary.distance` in METERS (optional). */
  readonly distance_m?: number;
  /** ORS `summary.duration` in SECONDS (optional). */
  readonly duration_s?: number;
}

/**
 * The committed `road-geometry.generated.json` shape: a checksum of the hub
 * coordinates the geometry was computed against (drift detection) plus a map of
 * directed {@link routeId} → {@link RoadLeg}. Any leg may be absent (it then
 * falls back to {@link greatCircle}).
 */
export interface RoadGeometryFile {
  /** {@link hubCoordsChecksum} of the hubs the geometry was precomputed for. */
  readonly hubChecksum: string;
  /** Road geometry keyed by directed `route-<from>-<to>` id. */
  readonly legs: Readonly<Record<string, RoadLeg>>;
}

/** Path of the committed generated file, resolved relative to THIS module. */
const GENERATED_GEOMETRY_PATH = fileURLToPath(
  new URL("./road-geometry.generated.json", import.meta.url),
);

/** Minimal structural guard — keeps the loaded JSON inside the typed contract. */
function isRoadGeometryFile(value: unknown): value is RoadGeometryFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { hubChecksum?: unknown; legs?: unknown };
  return typeof v.hubChecksum === "string" && typeof v.legs === "object" && v.legs !== null;
}

/**
 * Load the committed `road-geometry.generated.json` if it exists, else
 * `undefined`. This is the ONLY filesystem read in this module and it happens
 * lazily (when {@link buildRoutes} is first called WITHOUT an injected source),
 * never over the network — so determinism and import-time purity hold. A missing
 * file (the current state — no ORS key, nothing precomputed) is the normal
 * fallback path and returns `undefined` quietly.
 */
export function loadStaticRoadGeometry(): RoadGeometryFile | undefined {
  let raw: string;
  try {
    raw = readFileSync(GENERATED_GEOMETRY_PATH, "utf8");
  } catch {
    return undefined; // file absent -> great-circle fallback (back-compat).
  }
  const parsed: unknown = JSON.parse(raw);
  return isRoadGeometryFile(parsed) ? parsed : undefined;
}

/**
 * A stable, order-sensitive checksum of the hub coordinates a geometry file was
 * precomputed against. Stored alongside the geometry so a moved hub (stale
 * geometry) is test-detectable. Pure: a function of the hubs' `id/lon/lat` only
 * (rounded to 6 dp — ~0.1 m — so trivial float noise does not churn it).
 */
export function hubCoordsChecksum(hubs: readonly Hub[]): string {
  const round = (n: number): number => Math.round(n * 1e6) / 1e6;
  const canon = hubs.map((h) => `${h.hubId}:${round(h.lon)},${round(h.lat)}`).join("|");
  // Deterministic 32-bit FNV-1a over the canonical string -> 8-hex-char digest.
  let hash = 0x811c9dc5;
  for (let i = 0; i < canon.length; i += 1) {
    hash ^= canon.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Resolve one directed leg's geometry: the PRECOMPUTED road line from `file` if
 * present and usable (>= 2 vertices), else the deterministic {@link greatCircle}
 * arc. A road line's endpoints are SNAPPED EXACTLY to the hub coordinates so the
 * shape-agnostic seam (ws protocol + OpenLayers animation) stays anchored
 * regardless of ORS rounding. Pure: no I/O, a function of its arguments only.
 */
export function applyRoadGeometry(
  file: RoadGeometryFile | undefined,
  from: Hub,
  to: Hub,
  points: number,
): LonLat[] {
  const fallback = (): LonLat[] =>
    greatCircle([from.lon, from.lat], [to.lon, to.lat], points);
  if (file === undefined) return fallback();
  const leg = file.legs[routeId(from.hubId, to.hubId)];
  if (leg === undefined || leg.geometry.length < 2) return fallback();
  // Copy interior vertices verbatim; snap the two endpoints to the hub coords.
  const out: LonLat[] = leg.geometry.map((p) => [p[0], p[1]]);
  out[0] = [from.lon, from.lat];
  out[out.length - 1] = [to.lon, to.lat];
  return out;
}

/**
 * Build the hub-and-spoke linehaul routes for `hubs`. The first hub is the
 * center; every other hub gets a DIRECTED pair of legs (center -> spoke and
 * spoke -> center) so trailers can run trips in both directions and the
 * undirected graph is fully connected. Routes are returned in a stable,
 * deterministic order (input hub order).
 *
 * VIZ-06: each leg's geometry comes from precomputed ROAD geometry when
 * available, else the great-circle arc. The road source is `geometry` if
 * supplied (injectable for tests), otherwise the committed static file via
 * {@link loadStaticRoadGeometry} (absent today ⇒ great-circle fallback, so the
 * default behaviour is byte-identical to v1.0).
 */
export function buildRoutes(
  hubs: readonly Hub[],
  geometry?: RoadGeometryFile,
): Route[] {
  if (hubs.length < 2) return [];
  const file = geometry ?? loadStaticRoadGeometry();
  const center = hubs[0]!;
  const routes: Route[] = [];
  for (let i = 1; i < hubs.length; i += 1) {
    const spoke = hubs[i]!;
    routes.push({
      routeId: routeId(center.hubId, spoke.hubId),
      fromHubId: center.hubId,
      toHubId: spoke.hubId,
      geometry: applyRoadGeometry(file, center, spoke, ROUTE_POINTS),
    });
    routes.push({
      routeId: routeId(spoke.hubId, center.hubId),
      fromHubId: spoke.hubId,
      toHubId: center.hubId,
      geometry: applyRoadGeometry(file, spoke, center, ROUTE_POINTS),
    });
  }
  return routes;
}
