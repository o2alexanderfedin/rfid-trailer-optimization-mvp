/**
 * VIZ-06 — OFFLINE road-geometry precompute (dev script; never runs at sim/plan
 * time). Given an OpenRouteService API key in `ORS_API_KEY`, it calls the ORS
 * `driving-hgv` Directions API once per directed hub-and-spoke leg and writes
 * `packages/simulation/src/network/road-geometry.generated.json` — a committed
 * static file `buildRoutes` then prefers over the great-circle fallback.
 *
 * DETERMINISM: the NETWORK call lives ONLY here, behind an explicit `pnpm`/`tsx`
 * invocation. Nothing in this file is imported by the simulator, the API, or any
 * test — the sim reads the resulting JSON statically (byte-identical replay).
 *
 * NO-KEY PATH: with no `ORS_API_KEY` set, the script prints a clear message and
 * exits 0 WITHOUT writing — so the build/great-circle fallback is unaffected and
 * this script is safe to run in CI or a keyless dev box.
 *
 * RESILIENCE: a leg whose ORS call fails is SKIPPED (warned), not fatal — that
 * leg simply falls back to great-circle at load time. The file carries a
 * `hubChecksum` so a later hub move makes the stale geometry test-detectable.
 *
 * Run:  ORS_API_KEY=… pnpm tsx scripts/precompute-routes.ts
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { USA_HUBS } from "../packages/simulation/src/network/hubs.js";
import {
  hubCoordsChecksum,
  routeId,
  type RoadGeometryFile,
  type RoadLeg,
} from "../packages/simulation/src/network/routes.js";
import type { Hub, LonLat } from "../packages/domain/src/index.js";

/** ORS `driving-hgv` GeoJSON Directions endpoint. */
const ORS_URL = "https://api.openrouteservice.org/v2/directions/driving-hgv/geojson";

/** Where the generated file is written (the path `routes.ts` reads from). */
const OUTPUT_PATH = fileURLToPath(
  new URL("../packages/simulation/src/network/road-geometry.generated.json", import.meta.url),
);

/** The minimal slice of the ORS GeoJSON response this script consumes. */
interface OrsDirectionsGeoJson {
  readonly features: ReadonlyArray<{
    readonly geometry: { readonly coordinates: ReadonlyArray<readonly [number, number]> };
    readonly properties: {
      readonly summary?: { readonly distance?: number; readonly duration?: number };
    };
  }>;
}

function isOrsResponse(value: unknown): value is OrsDirectionsGeoJson {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { features?: unknown };
  return Array.isArray(v.features) && v.features.length > 0;
}

/**
 * RDP simplification tolerance in DEGREES (~0.02° ≈ 2 km). Bounds the committed
 * geometry to a few dozen points per leg (raw ORS is ~3k pts/leg ⇒ multi-MB) so
 * the static file + the ws snapshot stay small while the national-map road shape
 * is preserved. Endpoints are always kept (the loader re-snaps them to hub coords).
 */
const SIMPLIFY_EPSILON_DEG = 0.02;

/** Perpendicular distance from point `p` to segment `a–b` (degree space — fine for simplification). */
function perpDistance(p: LonLat, a: LonLat, b: LonLat): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Ramer–Douglas–Peucker polyline simplification. Pure + deterministic; always
 * preserves the first and last vertices. Reduces ~3k ORS points/leg to a few
 * dozen while keeping the highway's shape.
 */
function simplifyRDP(points: readonly LonLat[], epsilon: number): LonLat[] {
  if (points.length < 3) return points.map((p) => [p[0], p[1]]);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  let maxDist = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = perpDistance(points[i]!, first, last);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist > epsilon) {
    const left = simplifyRDP(points.slice(0, index + 1), epsilon);
    const right = simplifyRDP(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [[first[0], first[1]], [last[0], last[1]]];
}

/** Call ORS for a single directed leg; throw on any non-OK / malformed reply. */
async function fetchLeg(apiKey: string, from: Hub, to: Hub): Promise<RoadLeg> {
  const res = await fetch(ORS_URL, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
      Accept: "application/json, application/geo+json",
    },
    // ORS wants [lon, lat] coordinate pairs (GeoJSON axis order) — same as ours.
    body: JSON.stringify({
      coordinates: [
        [from.lon, from.lat],
        [to.lon, to.lat],
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`ORS ${res.status} ${res.statusText} for ${from.hubId}->${to.hubId}`);
  }
  const json: unknown = await res.json();
  if (!isOrsResponse(json)) {
    throw new Error(`ORS returned no features for ${from.hubId}->${to.hubId}`);
  }
  const feature = json.features[0]!;
  const rawGeometry: LonLat[] = feature.geometry.coordinates.map((c) => [c[0], c[1]]);
  // Bound the committed/streamed geometry (raw ORS is ~3k pts/leg) while keeping
  // the road shape (RDP, endpoints preserved → loader re-snaps to hub coords).
  const geometry: LonLat[] = simplifyRDP(rawGeometry, SIMPLIFY_EPSILON_DEG);
  const summary = feature.properties.summary;
  const leg: RoadLeg = {
    geometry,
    ...(summary?.distance !== undefined ? { distance_m: summary.distance } : {}),
    ...(summary?.duration !== undefined ? { duration_s: summary.duration } : {}),
  };
  return leg;
}

async function main(): Promise<void> {
  const apiKey = process.env.ORS_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    // No key: this is the expected default state. Do NOT write — the simulator's
    // great-circle fallback stays active and back-compatible.
    console.log(
      "[precompute-routes] ORS_API_KEY is not set — skipping ORS precompute.\n" +
        "  The simulator falls back to deterministic great-circle geometry.\n" +
        "  To generate road geometry: ORS_API_KEY=<key> pnpm tsx scripts/precompute-routes.ts",
    );
    process.exitCode = 0;
    return;
  }

  const hubs = USA_HUBS;
  const center = hubs[0]!;
  const legs: Record<string, RoadLeg> = {};
  let ok = 0;
  let failed = 0;

  for (let i = 1; i < hubs.length; i += 1) {
    const spoke = hubs[i]!;
    for (const [from, to] of [
      [center, spoke] as const,
      [spoke, center] as const,
    ]) {
      try {
        legs[routeId(from.hubId, to.hubId)] = await fetchLeg(apiKey, from, to);
        ok += 1;
      } catch (err) {
        failed += 1;
        console.warn(
          `[precompute-routes] ${from.hubId}->${to.hubId} failed (great-circle fallback): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  const file: RoadGeometryFile = { hubChecksum: hubCoordsChecksum(hubs), legs };
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  console.log(
    `[precompute-routes] wrote ${OUTPUT_PATH}\n` +
      `  ${ok} legs from ORS, ${failed} fell back to great-circle, ` +
      `hubChecksum=${file.hubChecksum}`,
  );
}

main().catch((err: unknown) => {
  console.error("[precompute-routes] fatal:", err);
  process.exitCode = 1;
});
