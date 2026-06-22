/**
 * Shared geography→transit derivation (v1.1 Phase-7 OPT-09/OPT-10 foundation).
 *
 * These pure helpers turn hub WGS84 coordinates into a leg's transit
 * distribution, and a `TimingConfig` into the single DETERMINISTIC planning
 * estimate (the log-normal MEAN via {@link expectedMinutes}). They live in
 * `@mm/domain` — the zero-(workspace-)dep leaf — so BOTH consumers read one
 * source of truth without a circular dependency:
 *
 *  - `@mm/simulation` re-imports {@link haversineKm} / {@link transitParamsForLeg}
 *    to build its per-leg sampler params (random draws).
 *  - `@mm/optimizer` (which CANNOT import `@mm/simulation`) imports
 *    {@link expectedTransitMinutes} / {@link expectedDwellMinutes} to plan
 *    against the same distributions deterministically.
 *
 * Everything here is PURE: no clock, no RNG, no I/O. Identical inputs ⇒
 * byte-identical output. All durations are MINUTES (1 sim tick = 1 minute).
 */

import type { Hub } from "./entities/index.js";
import { expectedMinutes, type LogNormalParams, type TimingConfig } from "./timing.js";

/** Degrees → radians. */
const DEG = Math.PI / 180;
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
 * FALLBACK PATH (VIZ-06 upgrade): this is the deterministic great-circle estimate
 * used when no ORS road `duration_s` is available for a leg. When VIZ-06's
 * `road-geometry.generated.json` carries a leg's ORS `summary.duration`, the
 * sim's `buildTransitParamsByLeg` and the optimizer's `twin-snapshot` prefer that
 * real drive time (seconds → minutes) over this haversine estimate; this pure
 * function stays UNCHANGED and remains the byte-identical fallback.
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
 * The deterministic per-leg transit ESTIMATE in minutes (OPT-09/OPT-10): the
 * log-normal MEAN of the leg's geography-derived transit distribution. Equals
 * `expectedMinutes(transitParamsForLeg(from, to, config.transit.sigma))` — so it
 * is the same closed-form mean the simulator's random draws converge to (DRY).
 *
 * Symmetric in `(from, to)` (geography is undirected) and pure.
 *
 * @param from   Leg origin hub (uses lon/lat only).
 * @param to     Leg destination hub (uses lon/lat only).
 * @param config Active timing config (supplies the transit `sigma` + clamp).
 * @returns The clamped distribution mean for the leg, in minutes.
 */
export function expectedTransitMinutes(from: Hub, to: Hub, config: TimingConfig): number {
  return expectedMinutes(transitParamsForLeg(from, to, config.transit.sigma));
}

/**
 * The deterministic dwell ESTIMATE in minutes for a hub's ROLE (Phase-6 TIME-02
 * parity): the log-normal MEAN of the role's dwell distribution. A `"center"`
 * hub (cross-dock, reload, contention) dwells longer than a `"spoke"`. Equals
 * `expectedMinutes(config.dwellCenter | config.dwellSpoke)`.
 *
 * Pure: a function of the role + config only.
 *
 * @param role   `"center"` (the hub-and-spoke center) or `"spoke"`.
 * @param config Active timing config (supplies the dwell distributions).
 * @returns The clamped dwell mean for the role, in minutes.
 */
export function expectedDwellMinutes(
  role: "center" | "spoke",
  config: TimingConfig,
): number {
  return expectedMinutes(role === "center" ? config.dwellCenter : config.dwellSpoke);
}
