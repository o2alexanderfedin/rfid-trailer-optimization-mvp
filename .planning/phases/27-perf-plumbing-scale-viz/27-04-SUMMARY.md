---
phase: 27-perf-plumbing-scale-viz
plan: "04"
subsystem: simulation
tags: [optimizer, coordinator, determinism, golden, reroute, lifo, capacity]

# Dependency graph
requires:
  - phase: 27-perf-plumbing-scale-viz
    provides: "27-01/02/03 — PERF-02/03 incremental twin-snapshot and VIZ-15/16 complete (wave 1)"
provides:
  - "optimizerRerouteFor with real destination choice (least-congested relief spoke)"
  - "real freeze/feasibility (per-leg transit median + dwell instead of constant FREEZE+1)"
  - "real blocks + per-leg capacity/travelMin/distanceMiles from fold state"
  - "NEW optimizer-on golden 162efbd8 captured reproducibility-first (COORD-06 criterion-1)"
  - "documented-divergence assertion (EQUALS flipped to DIFFERS from edfa5a6d/3920accc/94689f99)"
affects: [28-consolidated-audit, COORD-06-audit, phase-28-determinism-baseline]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pin-removal pattern: remove static twins with real fold-state data (inboundDepthByHub/transitByLeg/legMilesFor) for optimizer divergence"
    - "Reproducibility-first golden capture: in-process twice + 2 separate node processes BEFORE baking"
    - "Real block/capacity gate: uncapped inboundDepthByHub volume lets optimizer DECLINE over-capacity reroutes"

key-files:
  created: []
  modified:
    - packages/simulation/src/engine.ts
    - packages/simulation/src/coordinator/optimize.ts
    - packages/simulation/test/coordinator-optimizer-determinism.unit.test.ts

key-decisions:
  - "[P27-A] Route head = least-congested relief spoke (sorted by inboundDepthByHub asc, then hubId tie-break) — deterministic, no RNG/clock, bounded to center's partitioned slice"
  - "[P27-A] Block volume = inboundDepthByHub.get(trip.toHubId) UNCAPPED (> capacity → over-capacity → optimizer DECLINES), not min-capped at 50"
  - "[P27-A] departureOffsetMin = round(transitByLeg.median for current leg) + round(timingConfig.dwellSpoke.median) — real per-leg integer, always > freeze window for typical legs"
  - "[P27-A] epochResultToRerouteSuggestions: route[0] reading pattern stays CORRECT — after pin-removal it no longer always equals obs.centerId; docstring updated to reflect real alternatives"
  - "[P27-A] NEW optimizer-on golden: 162efbd8c02f64c7fed96e142ec9d26c3b26c283c44bf80979a67dc9d6d3f233 (divergent from edfa5a6d — fewer reroutes because some are declined)"

patterns-established:
  - "Fold-state-derived blocks for optimizer: use inboundDepthByHub as proxy for trailer load (packages pending at congested destination)"
  - "Real per-leg travelMin in fold slice: transitByLeg.get(routeId(from,to))?.median ?? constant fallback"
  - "Relief hub ranking: obs.spokes sorted by (inboundDepth asc, hubId asc) — deterministic, no RNG"

requirements-completed: [COORD-06]

# Metrics
duration: 75min
completed: 2026-06-27
---

# Phase 27 Plan 04: P27-A Optimizer-Divergent Reroute + New Golden Summary

**Optimizer-backed reroute is now genuinely route-aware-divergent: chooses least-congested spoke (not always center), declines over-capacity loads, producing new golden 162efbd8 that differs from rule-based edfa5a6d**

## Performance

- **Duration:** ~75 min
- **Started:** 2026-06-27T06:45:00Z
- **Completed:** 2026-06-27T08:02:35Z
- **Tasks:** 3 (Tasks 1+2 committed together, Task 3 committed separately)
- **Files modified:** 3

## Accomplishments

- Removed 3 structural pins from `optimizerRerouteFor` (engine.ts) so the optimizer has a real destination choice, real freeze/feasibility, and real capacity/blocks
- Updated `epochResultToRerouteSuggestions` docstring to reflect that route[0] is no longer always obs.centerId (it's now the per-trailer relief spoke)
- Captured NEW optimizer-on golden `162efbd8c02f64c7fed96e142ec9d26c3b26c283c44bf80979a67dc9d6d3f233` reproducibility-first (in-process twice + 2 separate node processes all identical)
- Flipped the documented-EQUALS assertion to documented-DIFFERS (COORD-06 criterion-1 satisfied)
- All 3 prior goldens (3920accc/edfa5a6d/94689f99) byte-identical (33 determinism tests pass)
- All 40 combined determinism tests pass; typecheck clean

## Reproducibility Evidence (required by critical determinism protocol)

**In-process verification (twice):**
- Run 1: `162efbd8c02f64c7fed96e142ec9d26c3b26c283c44bf80979a67dc9d6d3f233`
- Run 2: `162efbd8c02f64c7fed96e142ec9d26c3b26c283c44bf80979a67dc9d6d3f233`
- Equal: true

**Separate node process verification (two independent processes):**
- Process 1: `162efbd8c02f64c7fed96e142ec9d26c3b26c283c44bf80979a67dc9d6d3f233`
- Process 2: `162efbd8c02f64c7fed96e142ec9d26c3b26c283c44bf80979a67dc9d6d3f233`
- Both identical to in-process run: true

**Captured on:** arm64 darwin (same host as prior goldens, all prior goldens verified GREEN on this host)

## New Golden vs Prior Goldens

| Golden | Hash | Status |
|--------|------|--------|
| FLAGS_OFF | `3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861` | INTACT (byte-identical) |
| COORDINATOR_ON (rule-based) | `edfa5a6d40b36e3774797b60d7bd99b5a8af7cce97adb1e775bad0b56b514adc` | INTACT (byte-identical) |
| OODA_ON | `94689f9989c0019edff27134dad0ef4cfb07c15c9c308ef4b40c38e848f4e608` | INTACT (byte-identical) |
| COORDINATOR_OPTIMIZER_ON (NEW) | `162efbd8c02f64c7fed96e142ec9d26c3b26c283c44bf80979a67dc9d6d3f233` | NEW (P27-A divergent) |

All 4 goldens are distinct from each other.

## Reroute Count Changes

| Metric | Before P27-A | After P27-A | Change |
|--------|-------------|-------------|--------|
| suggested | 22290 | 20115 | -2175 |
| reroute | 9553 | 7378 | -2175 (optimizer DECLINES over-capacity) |
| accepted | 22269 | 20094 | -2175 |
| rejected | 21 | 21 | unchanged |
| accepted + rejected == suggested | ✓ | ✓ | invariant preserved |

The reroute count is lower because the optimizer now declines reroutes where `inboundDepthByHub.get(trip.toHubId) > COORDINATOR_OPTIMIZER_TRAILER_CAPACITY (50)` — over-capacity → `feasible=false` → gate 1 in the translator suppresses the suggestion.

## Task Commits

Each task was committed atomically:

1. **Task 1+2: Remove 3 pins + update optimizer translate docstring** - `6aeca51` (feat)
2. **Task 3: Capture new golden + flip EQUALS→DIFFERS** - `9a2d86f` (feat)

## Files Created/Modified

- `packages/simulation/src/engine.ts` — removed 3 structural pins from `optimizerRerouteFor`; route head is now per-trailer least-congested relief spoke; blocks from inboundDepthByHub; real per-leg travelMin/distanceMiles; real departure offset from transitByLeg
- `packages/simulation/src/coordinator/optimize.ts` — updated `epochResultToRerouteSuggestions` docstring: route[0] is now the optimizer's real chosen destination (not always centerId); wiring note added
- `packages/simulation/test/coordinator-optimizer-determinism.unit.test.ts` — new golden `162efbd8` baked; EQUALS → DIFFERS assertion flip; DIFFERS test extended to also assert != edfa5a6d; reroute counts recaptured (7378, suggested 20115)

## Decisions Made

- **Relief hub ranking**: Use `obs.spokes` sorted by `(inboundDepthByHub.get(hubId) asc, hubId asc)` — deterministic, bounded to this center's partitioned slice, no RNG/clock. Only considers the FIRST spoke with a different hubId from `trip.toHubId` (the simplest least-congested choice).
- **Block volume uncapped**: `inboundDepthByHub.get(trip.toHubId)` is NOT capped at `COORDINATOR_OPTIMIZER_TRAILER_CAPACITY`. When the congested hub has > 50 pending packages, the optimizer sees over-capacity → DECLINES. This is the key source of divergence (2175 fewer reroutes).
- **No LIFO infeasibility used**: Single-block trailers are always LIFO-trivially-satisfied. The divergence comes from CAPACITY infeasibility (over-capacity) not LIFO. This is simpler and produces the correct behavior.
- **Route[0] stays in the twin**: The `epochResultToRerouteSuggestions` function still reads `trailer.route[0]` from the twin — this is CORRECT because the twin now has real alternate destinations as route[0] (not always centerId). No change to the read-side logic needed.
- **Leg connectivity**: `allLegHubs` covers all route stop hubs (including relief spokes + original toHubId for each trailer), ensuring twin self-consistency.

## Deviations from Plan

None — plan executed exactly as written. The 3 pins were removed, the translator was updated, the golden was captured reproducibility-first, and the test was flipped.

## Known Stubs

None — the optimizer reroute path is fully wired with real fold-state data.

## Threat Flags

None — no new network endpoints, auth paths, or trust-boundary surface introduced. The changes are internal to the deterministic simulation engine with no I/O paths.

## Self-Check: PASSED

**Files exist:**
- `packages/simulation/src/engine.ts` — FOUND (modified)
- `packages/simulation/src/coordinator/optimize.ts` — FOUND (modified)
- `packages/simulation/test/coordinator-optimizer-determinism.unit.test.ts` — FOUND (modified)

**Commits exist:**
- `6aeca51` feat(27-04): remove 3 structural pins — FOUND
- `9a2d86f` feat(27-04): capture NEW optimizer-on golden — FOUND

**Golden verification:**
- `COORDINATOR_OPTIMIZER_ON_GOLDEN_SHA256 = 162efbd8c02f64c7fed96e142ec9d26c3b26c283c44bf80979a67dc9d6d3f233` — DIFFERS from edfa5a6d/3920accc/94689f99 ✓
- 3 prior goldens byte-identical ✓
- 40/40 determinism tests pass ✓
- typecheck: no errors ✓

---
*Phase: 27-perf-plumbing-scale-viz*
*Completed: 2026-06-27*
