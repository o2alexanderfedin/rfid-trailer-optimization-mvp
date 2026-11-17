/**
 * HUB-01 / HUB-02 / HUB-03 — OFFLINE big-city hub generator (dev script; never
 * runs at sim/plan/test time). It reads the pinned `all-the-cities` (MIT) dataset,
 * selects 1–3 metros per state by population, de-duplicates cross-state metros,
 * and writes the committed, content-checksummed
 * `packages/simulation/src/network/us-big-cities.generated.json` — the continental
 * topology's ROOT data dependency. Mirrors `scripts/precompute-routes.ts`
 * (committed-static-generated-data + checksum drift guard).
 *
 * DETERMINISM: the ONLY variable input (`all-the-cities`) is read HERE, behind an
 * explicit `pnpm tsx scripts/generate-hubs.ts` invocation. Nothing under the
 * packages' runtime `src` trees imports `all-the-cities` / `us` or this file —
 * the simulator reads ONLY the resulting JSON (byte-identical replay). No clock,
 * no RNG, no `Math.random`: identical dataset + this code yields byte-identical JSON.
 *
 * PURITY OF IMPORT: every pure helper below is exported for unit tests; ALL
 * dataset/filesystem effects live in `main()`, which only runs when this module
 * is the process entry point — so importing it for tests does no I/O.
 *
 * Run:  pnpm tsx scripts/generate-hubs.ts
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { haversineKm } from "../packages/domain/src/index.js";
import { hubCoordsChecksum } from "../packages/simulation/src/network/routes.js";
import {
  STATE_REGION_TZ,
  ADMIN1_TO_POSTAL,
  type StateMeta,
} from "./state-region-tz.js";

// --- Continental envelope (WGS84) — the SIM-01 validation box ----------------

/** Continental-USA latitude floor (inclusive). */
export const LAT_MIN = 24;
/** Continental-USA latitude ceiling (inclusive). */
export const LAT_MAX = 49;
/** Continental-USA longitude floor (inclusive). */
export const LON_MIN = -125;
/** Continental-USA longitude ceiling (inclusive). */
export const LON_MAX = -66;

/**
 * Predicate: is `(lat, lon)` inside the continental-USA envelope
 * (`lat∈[24,49]`, `lon∈[-125,-66]`, all inclusive)? Drops AK/HI and any offshore
 * point. Pure: a function of its two arguments only.
 */
export function withinContinentalEnvelope(lat: number, lon: number): boolean {
  return lat >= LAT_MIN && lat <= LAT_MAX && lon >= LON_MIN && lon <= LON_MAX;
}

// --- Selection thresholds (the ~80–130 envelope tuning knobs) ----------------
//
// These three module consts are the ONLY tuning knobs of the hub count. They are
// chosen against the pinned `all-the-cities` US data (GeoNames city-proper
// population — LOWER than metro population) so the dedup→select pipeline lands a
// deterministic 92 hubs, comfortably inside the [80,130] envelope. Rationale:
//   - Every state contributes its largest metro (floor 1) → ~49 base hubs.
//   - A 2nd metro is added only when it is itself a real city (≥100k city-proper)
//     → adds ~33 hubs (mid/large states).
//   - A 3rd metro is added only for genuinely poly-centric states (≥250k city-
//     proper 3rd city, e.g. CA/TX/FL) → adds ~10 hubs.

/** Rank-2 floor: a state's 2nd hub is added only if its city-proper pop ≥ this. */
export const POP_THRESHOLD_RANK2 = 100_000;
/** Rank-3 floor: a state's 3rd hub is added only if its city-proper pop ≥ this. */
export const POP_THRESHOLD_RANK3 = 250_000;
/**
 * Cross-state metro de-dupe radius (km). Two top-metro candidates in DIFFERENT
 * states within this great-circle distance are the same physical metro split by
 * a state line (e.g. NYC/Newark/Jersey City, Kansas City KS/MO, Philadelphia/
 * Wilmington) and collapse to the higher-population state's row. 40 km captures
 * those true cross-state metros without merging genuinely distinct nearby cities.
 */
export const METRO_DEDUPE_RADIUS_KM = 40;

/** Per-state shortlist depth fed into the dedupe pass (≥ cap 3, with headroom). */
export const SHORTLIST_PER_STATE = 5;

// --- Row shapes --------------------------------------------------------------

/**
 * A candidate city row in the selection pipeline. `rank` is assigned only by
 * {@link selectHubsPerState} (1-based per-state, by descending population), so it
 * is optional on the raw/pre-selection rows.
 */
export interface CityRow {
  readonly name: string;
  /** 2-letter postal code (the city's state). */
  readonly state: string;
  readonly population: number;
  readonly lat: number;
  readonly lon: number;
  /** 1-based per-state rank — set by {@link selectHubsPerState}. */
  readonly rank?: number;
}

/** A fully-resolved generated hub row (the committed JSON's element shape). */
export interface GeneratedHub {
  readonly hubId: string;
  readonly name: string;
  readonly state: string;
  readonly lat: number;
  readonly lon: number;
  readonly population: number;
  /** 1-based per-state population rank. */
  readonly rank: number;
  readonly region: StateMeta["region"];
  readonly timezone: string;
}

/** The committed `us-big-cities.generated.json` shape. */
export interface BigCitiesFile {
  /** {@link hubCoordsChecksum} of the generated hubs (drift guard — T-23-01). */
  readonly hubsChecksum: string;
  /** Provenance string incl. dataset version + GeoNames CC BY 4.0 attribution. */
  readonly generatedFrom: string;
  readonly hubs: readonly GeneratedHub[];
}

// --- Pure selection helpers (exported, no I/O) -------------------------------

/** Great-circle distance (km) between two `(lat, lon)` rows, via the shared domain `haversineKm`. */
function rowDistanceKm(a: CityRow, b: CityRow): number {
  // Reuse the domain haversine (do NOT hand-roll). It takes the `Hub` shape
  // (`{ lat, lon }` + ids); we pass minimal hub-shaped objects.
  return haversineKm(
    { hubId: a.state, name: a.name, lat: a.lat, lon: a.lon },
    { hubId: b.state, name: b.name, lat: b.lat, lon: b.lon },
  );
}

/**
 * Deterministic stable order for candidate rows: population DESC, then name ASC,
 * then state ASC — a total order with no ties, so every downstream pass (dedupe,
 * select, hubId suffixing) is reproducible.
 */
function byPopulationDesc(a: CityRow, b: CityRow): number {
  if (a.population !== b.population) return b.population - a.population;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.state < b.state ? -1 : a.state > b.state ? 1 : 0;
}

/**
 * Collapse cross-state metros to ONE row assigned to the highest-population
 * state. Walking rows in descending-population order, a row is DROPPED iff it is
 * within {@link METRO_DEDUPE_RADIUS_KM} of an already-kept row in a DIFFERENT
 * state — the kept row has ≥ population (it came first), so the survivor is the
 * higher-pop state's hub. Same-state neighbors are never collapsed (they are
 * distinct metros within one state). Pure + deterministic (stable total order).
 */
export function dedupeCrossStateMetro(cities: readonly CityRow[]): CityRow[] {
  const ordered = [...cities].sort(byPopulationDesc);
  const kept: CityRow[] = [];
  for (const c of ordered) {
    let collapse = false;
    for (const k of kept) {
      if (k.state === c.state) continue;
      if (rowDistanceKm(k, c) < METRO_DEDUPE_RADIUS_KM) {
        collapse = true;
        break;
      }
    }
    if (!collapse) kept.push(c);
  }
  return kept;
}

/**
 * The per-state floor-1 / cap-3 selection rule. Given the cities of ONE state,
 * returns 1–3 of them, each stamped with a 1-based `rank`:
 *   - rank 1: always the largest-population city.
 *   - rank 2: only if the 2nd-largest pop ≥ {@link POP_THRESHOLD_RANK2}.
 *   - rank 3: only if the 3rd-largest pop ≥ {@link POP_THRESHOLD_RANK3}.
 * Pure + deterministic (stable total order). Returns `[]` for an empty input.
 */
export function selectHubsPerState(citiesByState: readonly CityRow[]): CityRow[] {
  if (citiesByState.length === 0) return [];
  const sorted = [...citiesByState].sort(byPopulationDesc);
  const out: CityRow[] = [{ ...sorted[0]!, rank: 1 }];
  const second = sorted[1];
  if (second !== undefined && second.population >= POP_THRESHOLD_RANK2) {
    out.push({ ...second, rank: 2 });
    const third = sorted[2];
    if (third !== undefined && third.population >= POP_THRESHOLD_RANK3) {
      out.push({ ...third, rank: 3 });
    }
  }
  return out;
}

// --- hubId slug (stable, deterministic, collision-resolved) ------------------

/** Lowercase ASCII slug of a city name: alphanumerics kept, runs of others → "-". */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Assign a STABLE deterministic `hubId` to each selected hub: `<state>-<slug>`
 * (lowercase, e.g. `ny-new-york-city`). Collisions (same state + same slug) are
 * resolved by a documented stable suffix `-2`, `-3`, … assigned in the rows'
 * incoming (population-desc, then name/state) order — so the suffix is a pure
 * function of the deterministic input order, never of iteration nondeterminism.
 */
function assignHubIds(rows: readonly CityRow[]): Map<CityRow, string> {
  const seen = new Map<string, number>();
  const ids = new Map<CityRow, string>();
  for (const r of rows) {
    const base = `${r.state.toLowerCase()}-${slugify(r.name)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    ids.set(r, n === 1 ? base : `${base}-${n}`);
  }
  return ids;
}

// --- main(): the dataset → committed JSON pipeline (the ONLY I/O) -------------

/** Where the generated file is written (the path the simulator reads from). */
const OUTPUT_PATH = fileURLToPath(
  new URL("../packages/simulation/src/network/us-big-cities.generated.json", import.meta.url),
);

/** Round a WGS84 degree to 6dp (~0.1 m) so the committed coords are stable. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

async function main(): Promise<void> {
  // Lazy, dev-only import of the dataset (kept out of the module's import-time
  // surface so the test import does no work). `await import` keeps it ESM-pure.
  const { default: cities } = await import("all-the-cities");

  // Pinned dataset version for the provenance string (GeoNames CC BY 4.0).
  const require = createRequire(import.meta.url);
  const datasetVersion = (
    require("all-the-cities/package.json") as { version: string }
  ).version;

  // 1) US + continental-envelope filter, mapped to the normalized CityRow shape.
  const rows: CityRow[] = [];
  for (const c of cities) {
    if (c.country !== "US") continue;
    const lon = c.loc.coordinates[0];
    const lat = c.loc.coordinates[1];
    if (!withinContinentalEnvelope(lat, lon)) continue;
    const state = ADMIN1_TO_POSTAL[c.adminCode];
    if (state === undefined) continue; // unknown admin1 → reject at the boundary.
    rows.push({ name: c.name, state, population: c.population, lat, lon });
  }

  // 2) Shortlist the top-N per state (cheap, deterministic) BEFORE the O(n²)
  //    dedupe — the only rows that can ever be selected are a state's top metros.
  const byStateAll = new Map<string, CityRow[]>();
  for (const r of rows) {
    const list = byStateAll.get(r.state) ?? [];
    list.push(r);
    byStateAll.set(r.state, list);
  }
  const shortlist: CityRow[] = [];
  for (const list of byStateAll.values()) {
    shortlist.push(...[...list].sort(byPopulationDesc).slice(0, SHORTLIST_PER_STATE));
  }

  // 3) Cross-state metro de-dupe → 4) group by state → 5) floor-1/cap-3 select.
  const deduped = dedupeCrossStateMetro(shortlist);
  const byState = new Map<string, CityRow[]>();
  for (const r of deduped) {
    const list = byState.get(r.state) ?? [];
    list.push(r);
    byState.set(r.state, list);
  }
  const selected: CityRow[] = [];
  for (const list of byState.values()) {
    selected.push(...selectHubsPerState(list));
  }

  // 6) Resolve hubIds (collision-stable) over a deterministic order, attach
  //    region/timezone, round coords, then SORT by hubId ascending (the stable
  //    committed order → byte-identical re-emit + a stable checksum basis).
  const orderedForIds = [...selected].sort(byPopulationDesc);
  const ids = assignHubIds(orderedForIds);
  const hubs: GeneratedHub[] = orderedForIds
    .map((r): GeneratedHub => {
      const meta = STATE_REGION_TZ[r.state];
      if (meta === undefined) {
        throw new Error(`No region/timezone for state ${r.state} (${r.name})`);
      }
      const hubId = ids.get(r);
      if (hubId === undefined) throw new Error(`No hubId for ${r.state}/${r.name}`);
      return {
        hubId,
        name: r.name,
        state: r.state,
        lat: round6(r.lat),
        lon: round6(r.lon),
        population: r.population,
        rank: r.rank ?? 1,
        region: meta.region,
        timezone: meta.timezone,
      };
    })
    .sort((a, b) => (a.hubId < b.hubId ? -1 : a.hubId > b.hubId ? 1 : 0));

  // 7) Assertions (HUB-02/HUB-03) — fail the build, do NOT write a bad dataset.
  if (hubs.length < 80 || hubs.length > 130) {
    throw new Error(`hub count ${hubs.length} outside [80,130]`);
  }
  for (const h of hubs) {
    if (!withinContinentalEnvelope(h.lat, h.lon)) {
      throw new Error(`hub ${h.hubId} outside continental envelope`);
    }
  }
  const uniqueIds = new Set(hubs.map((h) => h.hubId));
  if (uniqueIds.size !== hubs.length) throw new Error("duplicate hubId(s)");

  // 8) Checksum (drift guard) + provenance, then write the committed file.
  const hubsChecksum = hubCoordsChecksum(hubs);
  const file: BigCitiesFile = {
    hubsChecksum,
    generatedFrom: `all-the-cities@${datasetVersion} (GeoNames CC BY 4.0)`,
    hubs,
  };
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  console.log(
    `[generate-hubs] wrote ${OUTPUT_PATH}\n` +
      `  ${hubs.length} hubs across ${byState.size} states, hubsChecksum=${hubsChecksum}\n` +
      `  generatedFrom=${file.generatedFrom}`,
  );
}

// Run main() ONLY when invoked as the process entry point (so test imports are
// inert). Compares this module's URL to the CLI entry file URL.
const entryUrl =
  process.argv[1] !== undefined ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryUrl) {
  main().catch((err: unknown) => {
    console.error("[generate-hubs] fatal:", err);
    process.exitCode = 1;
  });
}
