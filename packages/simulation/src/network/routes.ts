import type { Hub, LogNormalParams, LonLat, Route } from "@mm/domain";

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

/** Mean Earth radius (km), WGS84 — the haversine sphere radius. */
const EARTH_RADIUS_KM = 6371.0088;
/** Average highway HGV cruise speed (km/h) used to turn distance → minutes. */
const HGV_AVG_KMH = 80;

/**
 * Great-circle (haversine) distance in KM between two hubs, from their WGS84
 * lon/lat. Pure: no clock, no RNG; identical inputs ⇒ identical output. The
 * formula is symmetric and returns 0 for coincident points.
 */
export function haversineKm(a: Hub, b: Hub): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * TIME-01 — derive a directed leg's transit {@link LogNormalParams} from REAL
 * geography. The transit MEDIAN is the great-circle drive time at an 80 km/h
 * average HGV speed (`haversineKm(from, to) / 80 · 60` minutes), so a long coast
 * leg has a far larger typical transit than a short regional leg — replacing the
 * old single flat ~30-min median. `sigma` (log-space spread) is carried in from
 * the active timing config; the clamp band scales off the per-leg median
 * (`min = max(5, round(median·0.4))`, `max = round(median·3)`) so long legs are
 * not clipped by the old global `[10, 120]` band.
 *
 * NO-ORS-KEY PATH: this environment has no OpenRouteService key, so the median
 * source is the haversine distance. Once VIZ-06's `road-geometry.generated.json`
 * exists, swap the median to that leg's ORS `summary.duration` (seconds → minutes)
 * — the only line to change is the `median` below; sigma/clamp stay as-is.
 *
 * Pure: a function of the two hubs' coordinates (+ sigma) only.
 */
export function transitParamsForLeg(from: Hub, to: Hub, sigma: number): LogNormalParams {
  const median = (haversineKm(from, to) / HGV_AVG_KMH) * 60;
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
 * pair (center→spoke and spoke→center). Pure + deterministic (geometry only).
 */
export function buildTransitParamsByLeg(
  hubs: readonly Hub[],
  sigma: number,
): Map<string, LogNormalParams> {
  const byLeg = new Map<string, LogNormalParams>();
  if (hubs.length < 2) return byLeg;
  const center = hubs[0]!;
  for (let i = 1; i < hubs.length; i += 1) {
    const spoke = hubs[i]!;
    byLeg.set(routeId(center.hubId, spoke.hubId), transitParamsForLeg(center, spoke, sigma));
    byLeg.set(routeId(spoke.hubId, center.hubId), transitParamsForLeg(spoke, center, sigma));
  }
  return byLeg;
}

/**
 * Build the hub-and-spoke linehaul routes for `hubs`. The first hub is the
 * center; every other hub gets a DIRECTED pair of legs (center -> spoke and
 * spoke -> center) so trailers can run trips in both directions and the
 * undirected graph is fully connected. Routes are returned in a stable,
 * deterministic order (input hub order).
 */
export function buildRoutes(hubs: readonly Hub[]): Route[] {
  if (hubs.length < 2) return [];
  const center = hubs[0]!;
  const routes: Route[] = [];
  for (let i = 1; i < hubs.length; i += 1) {
    const spoke = hubs[i]!;
    const out = greatCircle([center.lon, center.lat], [spoke.lon, spoke.lat], ROUTE_POINTS);
    const back = greatCircle([spoke.lon, spoke.lat], [center.lon, center.lat], ROUTE_POINTS);
    routes.push({
      routeId: routeId(center.hubId, spoke.hubId),
      fromHubId: center.hubId,
      toHubId: spoke.hubId,
      geometry: out,
    });
    routes.push({
      routeId: routeId(spoke.hubId, center.hubId),
      fromHubId: spoke.hubId,
      toHubId: center.hubId,
      geometry: back,
    });
  }
  return routes;
}
