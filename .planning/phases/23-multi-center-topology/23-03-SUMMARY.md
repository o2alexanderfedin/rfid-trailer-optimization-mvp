---
phase: 23-multi-center-topology
plan: 03
subsystem: simulation
tags: [topology, multi-center, backbone, anti-spof, spoke-assignment, geonames, attribution, determinism, tdd]

# Dependency graph
requires:
  - phase: 23 (plan 01)
    provides: committed us-big-cities.generated.json — 92 continental big-city hubs (hubId/lat/lon/state/population/rank/region/timezone)
  - phase: 7 (v1.1)
    provides: "@mm/domain haversineKm — the shared great-circle basis (routes/twin/optimizer)"
provides:
  - "generateBigCityHubs(): readonly BigCityHub[] — loads the committed JSON via readFileSync + structural guard, sorted by hubId, pure for replay"
  - "BigCityHub interface — Hub + state/population/rank/region/timezone (the partition + ranking contract plan 23-04 consumes)"
  - "pickRegionalCenters(hubs, count): parameterized largest-metro-per-(region|timezone) partition selection, clamped [2, partitionCount], stable under reordering, tie-break by lowest hubId"
  - "assignSpokesToNearestCenter(spokes, centers, legCapKm): leg-capped great-circle nearest (in-partition first, global fallback), 6dp-rounded compare, id-tie-broken ReadonlyMap"
  - "buildBackbone(centers): n*(n-1) directed near-full-mesh BackboneLeg[] (geometry built in 23-04), sorted, no self-pairs"
  - "isConnectedWithoutAnyCenter(centers, backbone): anti-SPOF BFS connectivity guard"
  - "DEFAULT_CENTER_COUNT=6 / DEFAULT_LEG_CAP_KM=2500 documented defaults"
  - "GeoNames CC BY 4.0 attribution shipped in README + on-map UI attribution control (HUB-04)"
affects: [23-04 (buildRoutes/engine wiring behind continentalTopology flag), 23-05 (center-count checkpoint + partition snapshot), 24-28 (read this topology)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Committed-static-JSON loaded via readFileSync + structural guard (mirrors loadStaticRoadGeometry) instead of a static `with { type: \"json\" }` import — avoids needing resolveJsonModule under the repo's NodeNext + verbatimModuleSyntax typecheck"
    - "Pure topology fns: every output id-keyed-sorted, every tie broken by lowest stable hubId, coordinates rounded to 6dp before any assignment-deciding compare (anti-P12)"
    - "Reuse the shared @mm/domain haversineKm (no new geodesy dep) to keep the flags-off golden basis byte-identical"

key-files:
  created:
    - packages/simulation/src/network/centers.ts
    - packages/simulation/test/network/centers.unit.test.ts
  modified:
    - packages/simulation/src/network/hubs.ts
    - README.md
    - packages/web/src/map/MapView.tsx

decisions:
  - "Freight-corridor partition key = region|timezone (the dataset's Census region + IANA timezone) — 11 partitions over the 92-hub set, comfortably covering the 4-8 center envelope"
  - "Center selection rule: largest-population representative per partition, ordered population DESC (tie -> lowest hubId), take top `count`, clamp into [2, partitionCount] so it never collapses to one center"
  - "DEFAULT_CENTER_COUNT=6 (inside the locked 4-8 envelope) — a default only; the CONCRETE empirical value is plan 23-05's checkpoint; count is never hard-coded into the selection logic"
  - "DEFAULT_LEG_CAP_KM=2500 — spans the continental USA (coast-to-coast great-circle ~4000 km, but every spoke->nearest-center leg is far shorter), so no continental spoke is orphaned"
  - "generateBigCityHubs uses readFileSync (not a static JSON import) to match the proven road-geometry loader and avoid a resolveJsonModule typecheck regression"

# Metrics
duration: ~25min
completed: 2026-06-26
requirements-completed: [HUB-04, NET-02, NET-03, NET-04]
---

# Phase 23 Plan 03: Multi-Center Topology — Pure Topology Functions Summary

**Pure, deterministic multi-center topology: a JSON-backed `generateBigCityHubs`, a parameterized partition-based `pickRegionalCenters`, a leg-capped id-tie-broken `assignSpokesToNearestCenter`, a near-full-mesh `buildBackbone`, and an anti-SPOF `isConnectedWithoutAnyCenter` — all reusing the shared `@mm/domain` great-circle — plus the shipped GeoNames CC BY 4.0 attribution in README + the live map UI.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-06-26T18:28Z
- **Completed:** 2026-06-26
- **Tasks:** 3 (Tasks 1+2 are one TDD feature cycle: RED -> GREEN; Task 3 is the attribution)
- **Files:** 5 (2 created, 3 modified)

## Accomplishments

- **`generateBigCityHubs()`** (HUB-04) loads the committed 92-hub `us-big-cities.generated.json` as a fresh, sorted-by-`hubId` `readonly BigCityHub[]` via `readFileSync` + a structural guard — pure for replay (no clock/RNG/network), each call deeply-equal, every hub in the continental envelope. `USA_HUBS`/`MEMPHIS` are untouched (the flags-off path still uses them).
- **`pickRegionalCenters(hubs, count)`** (NET-02) partitions hubs by `region|timezone` (the freight-corridor proxy), picks the largest-population representative per partition (tie → lowest `hubId`), and returns exactly `count` distinct centers — honored for 4/6/8, clamped to `[2, partitionCount]` so it never collapses to one, sorted by `hubId`, and provably **stable under input reordering**. `count` is a plain parameter — no hard-coded literal in the module.
- **`assignSpokesToNearestCenter(spokes, centers, legCapKm)`** (NET-03) maps each spoke (iterated in sorted `hubId` order) to its in-partition great-circle nearest center within the cap, falling back to the global nearest — on **6dp-rounded coordinates** (a sub-6dp nudge cannot flip an assignment, anti-P12/T-23-06), **tie-broken by lowest center id**, deterministic.
- **`buildBackbone(centers)`** (NET-04) returns the near-full-mesh `n*(n-1)` directed `{fromHubId, toHubId}` legs (sorted, no self-pairs) — ≤2-hop coast-to-coast routing.
- **`isConnectedWithoutAnyCenter(centers, backbone)`** (NET-04, anti-SPOF/T-23-07) is a pure BFS that returns `true` for a full mesh and **`false` for a hub-of-hubs star** — the re-centralization/SPOF witness.
- **GeoNames CC BY 4.0 attribution** (HUB-04) ships in BOTH the README (new "Data attribution" section + a Stack line) and the live map UI (appended to the OSM source `attributions` so "City data © GeoNames, CC BY 4.0" renders in the on-map OL attribution control next to the OSM credit) — no new dependency.

## Task Commits

1. **Tasks 1+2 (RED): failing topology-function tests** - `e30808c` (test)
2. **Tasks 1+2 (GREEN): pure topology functions** - `183410f` (feat)
3. **Task 3: GeoNames CC BY 4.0 attribution** - `7835007` (docs)

_Tasks 1 & 2 are `type=tdd`; they form one feature (the `centers.ts` topology functions), so the RED commit (`e30808c`) covers all four functions' failing tests and the GREEN commit (`183410f`) lands the implementation. No refactor commit was needed (the GREEN implementation was already clean: lint + typecheck green, 18 tests pass)._

## TDD Gate Compliance

- **RED (`e30808c`):** `test(23-03)` — the 4-function test suite failing with `Cannot find module '../../src/network/centers.js'` (module absent). Verified RED before implementing.
- **GREEN (`183410f`):** `feat(23-03)` — all 18 centers tests pass; 327 simulation unit tests green; typecheck + eslint clean.
- **REFACTOR:** none needed.

Gate sequence (test → feat) satisfied.

## Files Created/Modified

- `packages/simulation/src/network/centers.ts` *(created, 213 lines)* — `pickRegionalCenters` / `assignSpokesToNearestCenter` / `buildBackbone` / `isConnectedWithoutAnyCenter` + `BackboneLeg` + `DEFAULT_CENTER_COUNT` / `DEFAULT_LEG_CAP_KM` / `COORD_DP`. All pure; reuses `@mm/domain` `haversineKm`.
- `packages/simulation/src/network/hubs.ts` *(modified)* — added `BigCityHub` interface + `generateBigCityHubs()` (readFileSync loader + structural guards). `USA_HUBS`/`MEMPHIS`/`hubRegisteredEvent` unchanged.
- `packages/simulation/test/network/centers.unit.test.ts` *(created, 18 tests)* — placed under `test/network/` so the `vitest run network/centers` path filter resolves it and the `unit` project (`packages/*/test/**/*.test.ts`) discovers it.
- `README.md` *(modified)* — new "Data attribution" section + a Stack line crediting GeoNames CC BY 4.0 (alongside OSM).
- `packages/web/src/map/MapView.tsx` *(modified)* — appended the GeoNames CC BY 4.0 credit to the OSM source `attributions` (on-map UI surface).

## Decisions Made

- **Partition key = `region|timezone`** — the dataset's Census region + IANA timezone is the documented freight-corridor proxy (per the locked CONTEXT decision); yields 11 partitions over the 92 hubs, covering the 4-8 envelope with headroom.
- **`generateBigCityHubs` reads via `readFileSync` (not a static JSON import)** — the repo's NodeNext + `verbatimModuleSyntax` typecheck does not enable `resolveJsonModule`, so a `with { type: "json" }` import would break `pnpm typecheck`. Mirroring the proven `loadStaticRoadGeometry` loader keeps the gate green and the runtime isolation identical (the only side effect is one committed-file read).
- **6dp coordinate rounding before assignment-deciding compares** — mirrors `hubCoordsChecksum`'s canonicalization (anti-P12/T-23-06); a unit test proves a 1e-9 lat/lon nudge does not re-partition any spoke.
- **`DEFAULT_LEG_CAP_KM = 2500`** — documented const; large enough that no continental spoke is orphaned, small enough that a pathological far-flung point would surface via the overflow rule.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Static JSON import would break the typecheck gate**
- **Found during:** Task 1 (planning the `generateBigCityHubs` loader).
- **Issue:** The plan's `key_links` describe `generateBigCityHubs` via a `static import of the committed JSON` (`import bigCities from "./us-big-cities.generated.json" with { type: "json" }`). The repo's `tsconfig.base.json` (NodeNext + `verbatimModuleSyntax`, no `resolveJsonModule`) makes such an import fail `pnpm typecheck`. Enabling `resolveJsonModule` repo-wide is a config change with regression risk to every package.
- **Fix:** Load the committed JSON via `readFileSync` + a structural guard, exactly mirroring the established `loadStaticRoadGeometry` pattern in `routes.ts`. Behavior is identical (pure for replay, one committed-file read, no city-data dep at runtime); the `key_links.pattern: "us-big-cities.generated"` still matches (the path is referenced in the loader).
- **Files modified:** `packages/simulation/src/network/hubs.ts`
- **Verification:** `pnpm typecheck` clean; `generateBigCityHubs` unit tests pass (sorted, in-envelope, pure, two calls deeply equal).
- **Committed in:** `183410f`

**2. [Rule 1 - Bug] Unused `Hub` import in the RED test tripped `noUnusedLocals`**
- **Found during:** GREEN typecheck (after RED was committed).
- **Issue:** The test imported `type Hub` from `@mm/domain` but used `BigCityHub` instead; `noUnusedLocals` failed `pnpm typecheck`.
- **Fix:** Removed the unused `Hub` import.
- **Files modified:** `packages/simulation/test/network/centers.unit.test.ts`
- **Verification:** `pnpm typecheck` clean; 18 tests still pass.
- **Committed in:** `183410f` (folded into GREEN)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug). Both keep the typecheck gate green; no scope change — every stated acceptance criterion is met.

## Requirements Completed

- **HUB-04** — `generateBigCityHubs()` consumes the committed dataset; GeoNames CC BY 4.0 attribution shipped in README + UI.
- **NET-02** — parameterized partition-based `pickRegionalCenters`.
- **NET-03** — leg-capped, id-tie-broken `assignSpokesToNearestCenter`.
- **NET-04** — near-full-mesh `buildBackbone` + anti-SPOF `isConnectedWithoutAnyCenter`.

## Threat Model Coverage

- **T-23-06 (Tampering — non-deterministic center selection / coordinate-noise spoke flip):** mitigated — 6dp rounding before assignment-deciding compares; tie-break by lowest stable `hubId`; a unit test proves a 1e-9 nudge does not re-partition. The committed partition snapshot lands in plan 23-05.
- **T-23-07 (DoS — backbone SPOF / re-centralization):** mitigated — `isConnectedWithoutAnyCenter` + the hub-of-hubs-FAILS test; near-full mesh keeps coast-to-coast ≤2 hops.
- **T-23-08 (Repudiation — missing dataset attribution):** mitigated — GeoNames CC BY 4.0 in README + UI, asserted by grep in verify.

No new security surface introduced (pure functions of committed data; text-only attribution; no new dependency, no network/auth/schema change).

## Known Stubs

None. All functions are fully wired to the committed dataset and independently tested. Wiring these pure functions into `buildRoutes`/engine flow behind the `continentalTopology` flag is plan 23-04 (out of scope here, by design).

## Next Phase Readiness

- The four pure topology functions + `generateBigCityHubs` are the contracts plan 23-04 consumes to generalize `buildRoutes`/engine flow behind the `continentalTopology` flag (and to capture the small-fixture continental golden).
- Plan 23-05 finalizes the empirical center `count` (a real continental run) and commits the partition snapshot; `DEFAULT_CENTER_COUNT=6` is a placeholder default, never a hard-coded selection literal.

## Self-Check: PASSED

- Files exist: `packages/simulation/src/network/centers.ts`, `packages/simulation/test/network/centers.unit.test.ts`, `packages/simulation/src/network/hubs.ts` (modified), `README.md` (modified), `packages/web/src/map/MapView.tsx` (modified) — all present.
- Commits present: `e30808c` (test), `183410f` (feat), `7835007` (docs) — all in git history.
- Gates re-run green: 18 centers tests pass; 327 simulation unit tests pass; `pnpm typecheck` clean; eslint clean on the new/changed files; GeoNames + CC BY 4.0 present in README and `packages/web/src` (MapView); 25 map UI tests pass (no map-component regression); no hard-coded `count` literal in the module.

---
*Phase: 23-multi-center-topology*
*Completed: 2026-06-26*
