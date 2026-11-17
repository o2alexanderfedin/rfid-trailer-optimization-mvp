---
phase: 28-continental-hardening
plan: "03"
subsystem: testing
tags: [vitest, simulation, determinism, continuation, continental-topology, ooda, coordinator, optimizer]

# Dependency graph
requires:
  - phase: 28-01
    provides: goldens.ts canonical golden constants (FLAGS_OFF_GOLDEN_SHA256, CONTINENTAL_GOLDEN_SHA256)
  - phase: 23-05
    provides: continentalTopology engine path (continentalArtifact, generateBigCityHubs, deriveCenterPartition)
  - phase: 19-08
    provides: runToHorizon / SimContinuation API — the chunked continuation contract

provides:
  - continental-continuation.unit.test.ts (DET-02 GAP-2 witness) — 10 tests proving continentalTopology chunked==all-at-once
  - stacked all-on continuation equivalence (continental+OODA+coordinators+optimizer, chunks 7/23/500)

affects:
  - 28-CONTEXT (GAP-2 closed — the continentalTopology continuation gap is now covered)
  - future continental regression (any change to arriveOverCarriedAtCenter/arriveConsolidationAtCenter routing must keep these tests green)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "opts-parameterised chunkedStream: multiple flag combos need one helper; ooda-continuation pattern extended with opts parameter"
    - "void import reference: import golden constants for audit context but void-reference them so TS strict unused-variable doesn't fire"

key-files:
  created:
    - packages/simulation/test/continental-continuation.unit.test.ts
  modified: []

key-decisions:
  - "chunkedStream takes opts as a parameter (not a module-level const) because two flag combos (CONTINENTAL_OPTS, ALL_ON_OPTS) share the helper — unlike ooda-continuation.unit.test.ts which only needs one combo"
  - "No new golden baked: all assertions are relative (hashStream(chunked) === hashStream(allAtOnce)); the full continental simulate() run would be a perf risk for a baked golden"
  - "continentalTopology routing structure is bootstrap-static (not in SerializedWorldState): the continuation equivalence test is a pure regression guard confirming no per-tick leakage from continental routing paths"
  - "void FLAGS_OFF_GOLDEN_SHA256 / void CONTINENTAL_GOLDEN_SHA256: imported for audit reference (DRY, single source from goldens.ts), not used in assertions — void prevents TS strict unused-import errors"
  - "Stacked chunk-1 skipped: every-tick boundary over the 5-subsystem all-on stack is very slow; per-subsystem continuation suites already cover chunk-1 individually"

patterns-established:
  - "Parameterised chunkedStream: when a continuation test covers multiple flag combos, accept opts as a parameter rather than duplicating the loop"

requirements-completed: [DET-02]

# Metrics
duration: 4min
completed: 2026-06-27
---

# Phase 28 Plan 03: Continental Continuation Equivalence Summary

**10-test continental-continuation.unit.test.ts closes DET-02 GAP-2: continentalTopology chunked==all-at-once across chunks 1/7/23/500 with continentalTopology alone and stacked with the full all-on flag set**

## Performance

- **Duration:** 4 min
- **Started:** 2026-06-27T20:20:12Z
- **Completed:** 2026-06-27T20:23:23Z
- **Tasks:** 1 of 1
- **Files modified:** 1 created

## Accomplishments

- Created `packages/simulation/test/continental-continuation.unit.test.ts` — 10 tests, all green on first run
- Describe 1 (continental continuation-equivalence keystone): fresh single-shot, chunks 7/23/500, chunk-1 every-tick boundary, JSON round-trip, off-path legacy equivalence
- Describe 2 (stacked all-on): chunks 7/23/500 with continental+OODA+coordinators+optimizer stack
- All 5 committed goldens byte-identical after adding the test (133 determinism tests + 10 new = 143 total green)
- `pnpm typecheck` clean throughout

## Task Commits

Each task was committed atomically:

1. **Task 1: Create continental-continuation.unit.test.ts** - `5d5fc79` (test)

**Plan metadata:** (final commit — see below)

## Files Created/Modified

- `packages/simulation/test/continental-continuation.unit.test.ts` — DET-02 GAP-2 witness: chunked==all-at-once with continentalTopology:true alone and stacked

## Decisions Made

- `chunkedStream` accepts `opts` as a parameter (not a module-level const) because two flag combos share the helper. This is a minor extension of the ooda-continuation.unit.test.ts template pattern.
- No new golden baked. All assertions are relative (hashStream(chunked) === hashStream(allAtOnce)). A full continental simulate() golden would require a perf investigation first.
- The JSDoc explicitly documents that `continentalTopology` routing structure is bootstrap-static (not in `SerializedWorldState`) — the continuation equivalence test is a pure regression guard, not a state-serialization fix.
- Stacked chunk-1 omitted: the full 5-subsystem all-on stack at chunk-1 over a meaningful horizon would be very slow; individual continuation suites already cover chunk-1 per subsystem.

## Deviations from Plan

None — plan executed exactly as written. The only structural difference from the ooda-continuation.unit.test.ts template is that `chunkedStream` takes `opts` as a parameter (needed because two flag combos reuse the helper). The plan spec noted this as acceptable: "make opts a parameter; otherwise a const is fine; mirror what keeps the code cleanest following the existing pattern."

## Issues Encountered

None. All 10 tests passed on the first run (no iteration required).

## Threat Surface Scan

No new production code touched. No new network endpoints, auth paths, file access patterns, or schema changes. Test-only file: zero threat surface addition.

## Known Stubs

None.

## Self-Check

- [x] `packages/simulation/test/continental-continuation.unit.test.ts` exists (FOUND)
- [x] Commit `5d5fc79` exists (`git log --oneline -3` confirms)
- [x] 10 tests pass (verified by vitest run output)
- [x] All 5 goldens intact — 133 determinism tests green
- [x] `pnpm typecheck` clean

## Self-Check: PASSED

## User Setup Required

None — test-only plan, no external service configuration required.

## Next Phase Readiness

- DET-02 GAP-2 fully closed
- The complete v3.0 determinism test inventory is now covered: flags-off gate, OODA/coordinator/optimizer/continental goldens, shuffle-invariance (GAP-1, plan 28-02), and continuation-equivalence across all 5 flag combos including continental
- Phase 28 is complete pending final metadata commit

---
*Phase: 28-continental-hardening*
*Completed: 2026-06-27*
