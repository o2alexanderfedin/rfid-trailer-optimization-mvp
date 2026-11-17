import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hub, HubRegistered } from "@mm/domain";

/**
 * SIM-01: the Phase-1 USA hub network. Ten real US metro sort hubs with WGS84
 * coordinates inside the continental-USA envelope (lat ∈ [24,49],
 * lon ∈ [-125,-66]). Memphis is the canonical Phase-1 skeleton hub (the world's
 * busiest cargo airport / classic middle-mile sort hub) and the hub-and-spoke
 * center.
 *
 * This list is a static, declarative constant — no clock, no RNG — so the
 * resulting event stream is reproducible (SIM-02 determinism). IATA codes are
 * used as stable hub ids.
 */
export const USA_HUBS: readonly Hub[] = [
  { hubId: "MEM", name: "Memphis", lat: 35.1495, lon: -90.049 },
  { hubId: "ORD", name: "Chicago", lat: 41.8781, lon: -87.6298 },
  { hubId: "DFW", name: "Dallas-Fort Worth", lat: 32.7767, lon: -96.797 },
  { hubId: "ATL", name: "Atlanta", lat: 33.749, lon: -84.388 },
  { hubId: "LAX", name: "Los Angeles", lat: 34.0522, lon: -118.2437 },
  { hubId: "JFK", name: "New York", lat: 40.7128, lon: -74.006 },
  { hubId: "DEN", name: "Denver", lat: 39.7392, lon: -104.9903 },
  { hubId: "PHX", name: "Phoenix", lat: 33.4484, lon: -112.074 },
  { hubId: "SEA", name: "Seattle", lat: 47.6062, lon: -122.3321 },
  { hubId: "IND", name: "Indianapolis", lat: 39.7684, lon: -86.1581 },
] as const;

/** The canonical single hub the Phase-1 walking skeleton renders + the spoke center. */
export const MEMPHIS: Hub = {
  hubId: "MEM",
  name: "Memphis",
  lat: 35.1495,
  lon: -90.049,
};

/**
 * Pure mapping from a hub to its `HubRegistered` event. Deterministic — no
 * ambient time/randomness; the persistence boundary assigns `occurred_at`.
 */
export function hubRegisteredEvent(hub: Hub): HubRegistered {
  return { type: "HubRegistered", schemaVersion: 1, payload: hub };
}

// --- HUB-04: the committed continental big-city dataset (plan 23-01) ---------
//
// The `continentalTopology` flag (plan 23-04) swaps the 10-hub `USA_HUBS` star
// for this ~80-130-hub set spoked to multiple regional centers. The dataset is a
// COMMITTED, content-checksummed `us-big-cities.generated.json` (emitted by the
// dev-only `scripts/generate-hubs.ts`); the runtime imports ONLY the committed
// JSON — never `all-the-cities`/`us` — so byte-identical replay is preserved.

/**
 * A continental big-city hub row (plan 23-01 dataset). Extends the `@mm/domain`
 * {@link Hub} contract (`hubId/name/lat/lon`) with the partition + ranking fields
 * the multi-center topology functions consume: postal `state`, GeoNames city
 * `population`, the per-state `rank` (1 = largest), the Census `region`, and the
 * IANA `timezone`. `region` + `timezone` together are the freight-corridor
 * partition key for {@link pickRegionalCenters}.
 */
export interface BigCityHub extends Hub {
  /** 2-letter postal state code (e.g. "TX"). */
  readonly state: string;
  /** GeoNames city-proper population (the ranking metric). */
  readonly population: number;
  /** Per-state population rank (1 = the state's largest hub). */
  readonly rank: number;
  /** US Census region — the corridor band (e.g. "South", "West"). */
  readonly region: string;
  /** IANA timezone (e.g. "America/Chicago") — the corridor sub-band. */
  readonly timezone: string;
}

/** The committed JSON's top-level shape (mirrors `road-geometry.generated.json`). */
interface BigCityHubsFile {
  readonly hubsChecksum: string;
  readonly generatedFrom: string;
  readonly hubs: readonly BigCityHub[];
}

/** Path of the committed generated dataset, resolved relative to THIS module. */
const GENERATED_HUBS_PATH = fileURLToPath(
  new URL("./us-big-cities.generated.json", import.meta.url),
);

/** Structural guard for one dataset row — keeps the loaded JSON inside the typed contract. */
function isBigCityHub(value: unknown): value is BigCityHub {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["hubId"] === "string" &&
    typeof v["name"] === "string" &&
    typeof v["lat"] === "number" &&
    typeof v["lon"] === "number" &&
    typeof v["state"] === "string" &&
    typeof v["population"] === "number" &&
    typeof v["rank"] === "number" &&
    typeof v["region"] === "string" &&
    typeof v["timezone"] === "string"
  );
}

/** Structural guard for the dataset file. */
function isBigCityHubsFile(value: unknown): value is BigCityHubsFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { hubs?: unknown };
  return Array.isArray(v.hubs) && v.hubs.every(isBigCityHub);
}

/**
 * HUB-04 — load the committed `us-big-cities.generated.json` continental hub set
 * as a fresh, sorted-by-`hubId` `readonly BigCityHub[]`. PURE for replay purposes
 * (no clock, no RNG, no network): the only side effect is a single `readFileSync`
 * of the committed, content-checksummed file (the SAME loader pattern as
 * {@link loadStaticRoadGeometry}; a static JSON import is avoided because the
 * repo's NodeNext + `verbatimModuleSyntax` typecheck does not enable
 * `resolveJsonModule`). Each call returns a NEW array (no shared mutable state),
 * deeply equal to every other call. The result is sorted ascending by `hubId` so
 * downstream id-keyed outputs are stable.
 *
 * Throws if the committed file is missing or structurally invalid — a hard
 * failure is correct (the dataset is the topology's root data dependency, not an
 * optional fallback like the road geometry).
 */
export function generateBigCityHubs(): readonly BigCityHub[] {
  const raw = readFileSync(GENERATED_HUBS_PATH, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isBigCityHubsFile(parsed)) {
    throw new Error("us-big-cities.generated.json: malformed or missing hubs[]");
  }
  return [...parsed.hubs].sort((a, b) =>
    a.hubId < b.hubId ? -1 : a.hubId > b.hubId ? 1 : 0,
  );
}
