import type { Hub, LonLat, Route } from "@mm/domain";

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
function routeId(fromHubId: string, toHubId: string): string {
  return `route-${fromHubId}-${toHubId}`;
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
