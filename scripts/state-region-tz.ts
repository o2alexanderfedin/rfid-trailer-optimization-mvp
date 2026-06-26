/**
 * HUB-02 / HUB-03 — the transcribed 50-state (+ DC) partition table that supplies
 * each big-city hub's `region` and IANA `timezone`, plus a GeoNames admin1 →
 * 2-letter postal map.
 *
 * DETERMINISM / NO-RUNTIME-DEP (locked CONTEXT decision): this table is
 * HAND-TRANSCRIBED, not derived from any npm package at generation time, so the
 * committed `us-big-cities.generated.json` is a pure function of (a) the pinned
 * `all-the-cities` dataset and (b) this constant. The simulator/runtime never
 * imports this file — only `scripts/generate-hubs.ts` does, behind its `main()`
 * guard. No clock, no RNG, no I/O here.
 *
 * REGION partition: U.S. Census Bureau's four statistical regions
 * (Northeast / Midwest / South / West). DC is grouped with the South (its Census
 * division). The region is the freight-corridor / timezone partition input that
 * Plan 23-02 reads to choose regional sort centers.
 *
 * TIMEZONE: each state's PREDOMINANT IANA zone (a few states straddle a zone
 * boundary — e.g. FL/IN/KY/TN/TX — but the demo network keys on one canonical
 * zone per state; the chosen zone is the one covering the state's largest metro).
 */

/** The closed set of U.S. Census regions used for the freight/timezone partition. */
export const US_REGIONS = ["Northeast", "Midwest", "South", "West"] as const;
export type UsRegion = (typeof US_REGIONS)[number];

/** Per-state partition metadata: Census region + predominant IANA timezone. */
export interface StateMeta {
  readonly region: UsRegion;
  readonly timezone: string;
}

/**
 * 2-letter postal code → { region, IANA timezone }. Exactly 51 entries (all 50
 * states + DC). The IANA zone for each state is its PREDOMINANT zone (covering
 * the state's largest metro).
 *
 * NON-CONTINENTAL STATES (AK, HI): present for completeness (the table is the
 * canonical 50-state + DC partition) but they NEVER enter the hub set — every
 * Alaskan/Hawaiian city is outside the continental envelope `lat∈[24,49] /
 * lon∈[-125,-66]` and is dropped before selection. They carry their REAL IANA
 * zones (`America/Anchorage`, `Pacific/Honolulu`); only HI's `Pacific/Honolulu`
 * is non-`America/*` (geographically unavoidable — Hawaii has no `America/` zone).
 * Continental hubs are therefore all `America/*`; the lone `Pacific/*` value is on
 * a row that is provably never realized as a hub.
 */
export const STATE_REGION_TZ: Readonly<Record<string, StateMeta>> = {
  AL: { region: "South", timezone: "America/Chicago" },
  AK: { region: "West", timezone: "America/Anchorage" },
  AZ: { region: "West", timezone: "America/Phoenix" },
  AR: { region: "South", timezone: "America/Chicago" },
  CA: { region: "West", timezone: "America/Los_Angeles" },
  CO: { region: "West", timezone: "America/Denver" },
  CT: { region: "Northeast", timezone: "America/New_York" },
  DE: { region: "South", timezone: "America/New_York" },
  DC: { region: "South", timezone: "America/New_York" },
  FL: { region: "South", timezone: "America/New_York" },
  GA: { region: "South", timezone: "America/New_York" },
  HI: { region: "West", timezone: "Pacific/Honolulu" },
  ID: { region: "West", timezone: "America/Boise" },
  IL: { region: "Midwest", timezone: "America/Chicago" },
  IN: { region: "Midwest", timezone: "America/Indiana/Indianapolis" },
  IA: { region: "Midwest", timezone: "America/Chicago" },
  KS: { region: "Midwest", timezone: "America/Chicago" },
  KY: { region: "South", timezone: "America/New_York" },
  LA: { region: "South", timezone: "America/Chicago" },
  ME: { region: "Northeast", timezone: "America/New_York" },
  MD: { region: "South", timezone: "America/New_York" },
  MA: { region: "Northeast", timezone: "America/New_York" },
  MI: { region: "Midwest", timezone: "America/Detroit" },
  MN: { region: "Midwest", timezone: "America/Chicago" },
  MS: { region: "South", timezone: "America/Chicago" },
  MO: { region: "Midwest", timezone: "America/Chicago" },
  MT: { region: "West", timezone: "America/Denver" },
  NE: { region: "Midwest", timezone: "America/Chicago" },
  NV: { region: "West", timezone: "America/Los_Angeles" },
  NH: { region: "Northeast", timezone: "America/New_York" },
  NJ: { region: "Northeast", timezone: "America/New_York" },
  NM: { region: "West", timezone: "America/Denver" },
  NY: { region: "Northeast", timezone: "America/New_York" },
  NC: { region: "South", timezone: "America/New_York" },
  ND: { region: "Midwest", timezone: "America/Chicago" },
  OH: { region: "Midwest", timezone: "America/New_York" },
  OK: { region: "South", timezone: "America/Chicago" },
  OR: { region: "West", timezone: "America/Los_Angeles" },
  PA: { region: "Northeast", timezone: "America/New_York" },
  RI: { region: "Northeast", timezone: "America/New_York" },
  SC: { region: "South", timezone: "America/New_York" },
  SD: { region: "Midwest", timezone: "America/Chicago" },
  TN: { region: "South", timezone: "America/Chicago" },
  TX: { region: "South", timezone: "America/Chicago" },
  UT: { region: "West", timezone: "America/Denver" },
  VT: { region: "Northeast", timezone: "America/New_York" },
  VA: { region: "South", timezone: "America/New_York" },
  WA: { region: "West", timezone: "America/Los_Angeles" },
  WV: { region: "South", timezone: "America/New_York" },
  WI: { region: "Midwest", timezone: "America/Chicago" },
  WY: { region: "West", timezone: "America/Denver" },
} as const;

/**
 * GeoNames admin1 → 2-letter postal map. In the pinned `all-the-cities` dataset,
 * a US city's `adminCode` is ALREADY the 2-letter postal code (e.g. "AL", "TX"),
 * so this is an identity-validating lookup: it normalizes/validates an incoming
 * admin1 code to a known postal and is the single point where an unexpected code
 * is rejected (returns `undefined`). It is derived from {@link STATE_REGION_TZ}
 * so it provably covers exactly the same 51 keys (the test round-trips both).
 */
export const ADMIN1_TO_POSTAL: Readonly<Record<string, string>> = Object.fromEntries(
  Object.keys(STATE_REGION_TZ).map((postal) => [postal, postal]),
);
