---
phase: 23-multi-center-topology
plan: 01
subsystem: infra
tags: [all-the-cities, geonames, hub-generation, dataset, determinism, checksum, tsx]

# Dependency graph
requires:
  - phase: 22 (v2.0 close)
    provides: precompute-routes.ts committed-generated-data + hub-checksum drift-guard pattern; hubCoordsChecksum FNV-1a primitive; @mm/domain haversineKm
provides:
  - "Committed, content-checksummed us-big-cities.generated.json — 92 continental big-city hubs (1-3/state by population)"
  - "Dev-only scripts/generate-hubs.ts generator (mirrors precompute-routes.ts; all I/O behind a main() entry guard)"
  - "scripts/state-region-tz.ts — 50-state + DC region/IANA-timezone partition const (STATE_REGION_TZ) + ADMIN1_TO_POSTAL"
  - "Pure, tested selection helpers: selectHubsPerState (floor-1/cap-3), dedupeCrossStateMetro, withinContinentalEnvelope"
affects: [23-02 (centers/backbone reads the hub set), 23-03 spoke-assignment, 23-04 scope-partition, 23-05 drift-guard test, multi-center-topology]

# Tech tracking
tech-stack:
  added: [all-the-cities@3.1.0 (dev), us@2.0.0 (dev)]
  patterns: ["committed-static-generated-data + content checksum (mirrors road-geometry)", "dev-only generator with main() entry-point guard so test import is I/O-free", "ambient .d.ts for an untyped dev dataset (no any)"]

key-files:
  created:
    - scripts/generate-hubs.ts
    - scripts/state-region-tz.ts
    - scripts/all-the-cities.d.ts
    - packages/simulation/src/network/us-big-cities.generated.json
    - packages/simulation/test/generate-hubs.unit.test.ts
  modified:
    - package.json
    - pnpm-lock.yaml

key-decisions:
  - "Thresholds POP_THRESHOLD_RANK2=100k / POP_THRESHOLD_RANK3=250k chosen against the pinned all-the-cities city-proper population to land a deterministic 92 hubs inside [80,130]"
  - "Cross-state metro dedupe radius = 40 km (captures NYC/NJ, Kansas City KS/MO, Philadelphia/Wilmington; does not merge distinct nearby cities)"
  - "hubId = <state>-<slug(name)> with a stable -2/-3 suffix on collision (deterministic over the population-desc input order)"
  - "all-the-cities adminCode is ALREADY the 2-letter postal in the US dataset; ADMIN1_TO_POSTAL is an identity-validating map (rejects unknown codes at the boundary)"

patterns-established:
  - "Dev-only dataset generator: pure helpers exported for unit tests; ALL dataset/fs effects in main(), run ONLY when the module is the process entry point"
  - "Shortlist top-5/state BEFORE the O(n^2) cross-state dedupe so the pass stays fast (245 rows) while still catching every cross-state metro"

requirements-completed: [HUB-01, HUB-02, HUB-03]

# Metrics
duration: 18min
completed: 2026-06-26
---

# Phase 23 Plan 01: Multi-Center Topology — Big-City Hub Dataset Summary

**Dev-only `all-the-cities` generator emits a committed, FNV-1a-checksummed `us-big-cities.generated.json` of 92 continental big-city hubs (1-3 per state by population, cross-state metros de-duped, each with Census region + IANA timezone), byte-identical on re-emit and never imported by the runtime.**

## Performance

- **Duration:** ~18 min
- **Started:** 2026-06-26T11:02Z
- **Completed:** 2026-06-26T11:10Z
- **Tasks:** 2 (Task 1 is a TDD cycle: test -> feat)
- **Files modified:** 7 (5 created, 2 modified)

## Accomplishments
- 92-hub continental dataset generated deterministically from the pinned `all-the-cities` (MIT) dataset, 1-3 hubs/state by population (floor 1 / cap 3 above documented thresholds), all inside the continental envelope.
- Cross-state metros collapse to the highest-population state (e.g. Newark/Jersey City -> NY; Overland Park -> Kansas City MO) via the shared `@mm/domain` `haversineKm`.
- Committed JSON carries `hubsChecksum=66ec8b81` (drift guard, T-23-01) and a GeoNames CC BY 4.0 provenance string (`generatedFrom: all-the-cities@3.1.0 (GeoNames CC BY 4.0)`).
- Runtime isolation proven: nothing under `packages/*/src` imports `all-the-cities`/`us`; the sim reads only the committed JSON (byte-identical replay preserved).
- 19 pure-helper unit tests pass; full simulation unit suite (309 tests) green; `pnpm typecheck` + `eslint` clean (no `any`, no type assertions).

## Task Commits

1. **Task 1 (RED): failing tests for selection helpers** - `244ed3e` (test)
2. **Task 1 (GREEN): helpers + state/region/tz const** - `b910bf1` (feat)
3. **Task 2: emit committed checksummed JSON + dev deps** - `45aef4d` (feat)

_Task 1 is `type=tdd`: RED (`244ed3e`) -> GREEN (`b910bf1`). No refactor commit was needed._

## Files Created/Modified
- `scripts/state-region-tz.ts` - 50-state + DC `STATE_REGION_TZ` (Census region + IANA timezone) and `ADMIN1_TO_POSTAL` identity-validating map (51 entries).
- `scripts/generate-hubs.ts` - The dev-only generator: pure `selectHubsPerState` / `dedupeCrossStateMetro` / `withinContinentalEnvelope` (+ thresholds) exported for tests; `main()` runs the dataset->JSON pipeline only when invoked as the entry point.
- `scripts/all-the-cities.d.ts` - Minimal dev-only ambient module type for the untyped `all-the-cities` dataset (avoids `any`).
- `packages/simulation/src/network/us-big-cities.generated.json` - The committed, checksummed 92-hub dataset (the continental topology's root data dependency).
- `packages/simulation/test/generate-hubs.unit.test.ts` - 19 unit tests for the pure helpers + the state const (placed under `packages/simulation/test/` so the configured `unit` vitest project discovers it; imports the `scripts/` helpers via relative path — test-only, runtime never does).
- `package.json` / `pnpm-lock.yaml` - Added `all-the-cities` + `us` as DEV dependencies.

## Decisions Made
- **Population thresholds (100k / 250k) + dedupe radius (40 km)** documented inline as the sole hub-count tuning knobs; verified to yield 92 hubs (mid-range of [80,130]).
- **GeoNames city-proper population** (the dataset's metric) is lower than metro population, so the thresholds are set accordingly; this is documented in the generator.
- **`us` dev dependency** was added per the plan's Task 2 action, but the region/timezone table is HAND-TRANSCRIBED in `state-region-tz.ts` per the locked CONTEXT decision (determinism-safe, not a runtime dep); `us` is not imported.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `all-the-cities` adminCode is already the 2-letter postal, not a raw GeoNames admin1 numeric**
- **Found during:** Task 1 / Task 2 (dataset inspection)
- **Issue:** The plan's interface comment described `adminCode` as "GeoNames admin1, NOT postal". In the pinned `all-the-cities@3.1.0` US data, `adminCode` is already the 2-letter postal (e.g. "TX"). A numeric-admin1 -> postal map would have mapped nothing.
- **Fix:** `ADMIN1_TO_POSTAL` is implemented as an identity-validating map derived from `STATE_REGION_TZ` (51 keys); it normalizes/validates an incoming code and rejects unknowns at the boundary. The artifact contract ("round-trips every postal", `ADMIN1_TO_POSTAL` present) is satisfied.
- **Files modified:** scripts/state-region-tz.ts
- **Verification:** `ADMIN1_TO_POSTAL` round-trips all 51 postals (unit test); generator maps every US row's `adminCode` to a known state.
- **Committed in:** b910bf1

**2. [Rule 1 - Bug] `STATE_REGION_TZ` "all timezones America/*" vs the 51-entry (50 states + DC) requirement**
- **Found during:** Task 1 (writing the const)
- **Issue:** The plan's behavior spec wanted BOTH "exactly 51 entries (50 states + DC)" AND "every timezone starts with America/". These are mutually exclusive: the 50-state set necessarily includes Hawaii, whose only IANA zone is `Pacific/Honolulu` (no `America/` zone exists).
- **Fix:** Kept all 51 canonical rows (50 states + DC) with honest IANA zones; HI carries `Pacific/Honolulu`. AK/HI never realize as hubs (outside the continental envelope), so every CONTINENTAL hub is `America/*`. The test asserts "valid IANA zone for every state" AND "`America/*` for every state except HI".
- **Files modified:** scripts/state-region-tz.ts, packages/simulation/test/generate-hubs.unit.test.ts
- **Verification:** 51-entry + valid-IANA + per-state-America/* unit tests pass; the generated JSON's 92 continental hubs are all `America/*`.
- **Committed in:** b910bf1

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** Both align the plan's literal wording with the actual pinned-dataset shape and geographic reality. No scope creep; all stated acceptance criteria are met (count, envelope, unique ids, region+tz, checksum, provenance, deterministic re-emit, runtime isolation).

## Issues Encountered
- esbuild prematurely closed the file's JSDoc banner on a literal `*/` inside an inline path (`packages/*/src`). Rephrased the comment to avoid `*/`; transform then succeeded.
- The `@mm/domain` workspace alias is not resolvable from `scripts/` under the vitest node resolver. Matched the existing `precompute-routes.ts` convention and imported `haversineKm` via the relative path `../packages/domain/src/index.js`.

## User Setup Required
None - no external service configuration required. `all-the-cities` ships its dataset offline as a dev dependency.

## Threat Model Coverage
- **T-23-01 (tampering with the dataset):** mitigated — `hubsChecksum` (`hubCoordsChecksum` FNV-1a) is committed in the file; the drift-guard re-derivation test lands in plan 23-05 (out of scope here). A data change becomes a visible checksum diff.
- **T-23-02 (upstream version drift):** mitigated — generator is dev-only/offline; runtime imports only the committed JSON, so an `all-the-cities` bump cannot affect replay until the generator is deliberately re-run and the JSON re-committed.

## Next Phase Readiness
- The 92-hub committed dataset is the root data dependency for plans 23-02..05 (centers, backbone, spoke assignment, scope partition, drift guard) and Phases 24-28.
- Not yet wired into `network/hubs.ts` / `buildRoutes` — that generalization (and the flags-off byte-identical equivalence to the legacy 10-hub single-center input) is the next plan's work, behind the `continentalTopology` flag.

## Self-Check: PASSED

All created files present on disk; all task commits (`244ed3e`, `b910bf1`, `45aef4d`) present in git history. Acceptance gates re-run green: count 92 in [80,130], all hubs in the continental envelope, unique ids, region+IANA tz present, `hubsChecksum=66ec8b81`, byte-identical re-emit, runtime-isolation clean, 19 helper tests + 309 simulation unit tests pass, `pnpm typecheck` + `eslint` clean.

---
*Phase: 23-multi-center-topology*
*Completed: 2026-06-26*
