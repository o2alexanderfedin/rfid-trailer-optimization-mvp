---
gsd_state_version: 1.0
milestone: v3.0
milestone_name: Continental OODA Network
status: executing
stopped_at: Phase 27 UI-SPEC approved
last_updated: "2026-06-27T06:18:56.536Z"
last_activity: 2026-06-27
progress:
  total_phases: 6
  completed_phases: 4
  total_plans: 17
  completed_plans: 18
  percent: 100
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-26)

**Core value:** Generate route-aware, LIFO-correct trailer load plans that minimize blocked-freight rehandle and continuously repair them as conditions change — demonstrated live over a simulated USA hub network.
**Current focus:** Phase 26 — Coordinator Optimizer

## Current Position

Phase: 26 (Coordinator Optimizer) — EXECUTING
Plan: 3 of 3
Status: Ready to execute
Last activity: 2026-06-27

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: — min
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

*Updated after each plan completion*
| Phase 23 P04 | 50 | 3 tasks | 8 files |
| Phase 23 P05 | 70min | 4 tasks | 6 files |
| Phase 24 P24-01 | 13min | 3 tasks | 31 files |
| Phase 24 P24-04 | 15min | 3 tasks | 8 files |
| Phase 25 P25-01 | 13 | 3 tasks | 23 files |
| Phase 25 P25-02 | 12min | 3 tasks | 8 files |
| Phase 26 P26-02 | 14min | 3 tasks | 5 files |
| Phase 26 P26-03 | 70min | 3 tasks | 3 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting v3.0:

- [v3.0 Roadmap 2026-06-26]: 6-phase spine adopted from research SUMMARY (A→E + Hardening), continuing phase numbering from v2.0's Phase 22 → Phases **23–28**. Phase 23 Topology (FOUNDATION) → 24 OODA → 25 Coordinators (rule-based) → 26 Coordinator↔Optimizer → 27 Perf+Plumbing+Scale Viz → 28 Continental Hardening (consolidated DET-02 audit). Hard-sequenced: A before everything; B before C (agents must exist to arbitrate); D needs C; E independent (interleaves with 25/26). Every phase re-asserts the two-part flags-off gate (`flag:false===absent` AND `absent⇒3920accc…`); model-changing phases capture their own new golden.
- [v3.0 Roadmap 2026-06-26]: **PERF-01 (`applyHubInventory` key-scoping) pulled into Phase 23 as P1-BLOCKING** — the rest of E's perf work is deferrable, but this one converts a latent O(events×hubs) freeze into an active one the moment hub count jumps to 100. It ships with the topology, not as hardening.
- [v3.0 Roadmap 2026-06-26]: **Center count is parameterized and chosen empirically in Phase 23** (user deferred the exact number to Phase A). Research default ~5–6 on a near-full-mesh backbone (envelope ~4–8); the leg-length cap + anti-SPOF remove-any-center connectivity test are mandatory regardless; never collapse to a single primary.
- [v3.0 Design (PROJECT.md Key Decisions)]: multi–regional-center topology · great-circle arcs (no per-leg ORS at scale) · OODA as event-emitting `step()` (not ABM) · coordinators as ES process-managers · advisory-first (agents arbitrate w/ local feasibility) · coordinators *may* use the optimizer · `async-queue` for runtime plumbing only (ESLint-banned from the core) · every feature flag-gated, new goldens, flags-off byte-identical to `3920accc…`.
- [Phase 23-04 NET-01/NET-05]: `continentalTopology` flag (strict `=== true`, default off) generalizes `buildRoutes`/`buildTransitParamsByLeg` + the engine freight flow off the hard-wired Memphis center to a `centerOf(spoke)` model. OFF ⇒ `centerOf` collapses to `hubs[0]`, no new RNG substream is constructed, and the legacy single-center stream + the seed-42 10k golden `3920accc…` are byte-identical; ON ⇒ freight flows spoke → its center → backbone → dest center → dest spoke (the cross-center hop lives in `arriveConsolidationAtCenter`). `detectAffectedScope` gains an additive `partitionScopeByCenter(scope, centerOf, events)` so one center's epoch never pulls another's trailers. Empirical `centerCount` + the partition snapshot are deferred to plan 23-05.
- [Phase 23]: Center count = 6 (empirical, NET-02): best fan-out balance + cheap 30-leg mesh + anti-SPOF + all spoke legs under cap; recorded in committed center-partition.snapshot.json (partitionChecksum=883c337b)
- [Phase 23]: Continental golden 8f91b13f captured reproducibility-first on a 14-hub fixture; DET-01 two-part gate: continentalTopology:false===absent AND absent=>seed-42 10k golden 3920accc byte-identical
- [Phase ?]: OODA_RNG_SALT = 0x7a9e3f1d (eighth substream salt, pairwise-distinct from the 7 engine salts)
- [Phase ?]: TrailerDiverted payload = {trailerId, tripId, fromHubId, toHubId, reason, occurredAt} — ids + clock only, no geo/RNG
- [Phase ?]: Truck Decide priority ladder: rest > refuel > divert > hold > proceed (binding feasibility first)
- [Phase ?]: [Phase 24-04] OODA-05: activeTripByTrailer serialized into SerializedWorldState (present-only-when-on); per-agent RNG stateless re-derive so no new rng field; chunked OODA-on run byte-identical to all-at-once
- [Phase ?]: [Phase 24-04] OODA-on golden 94689f99… (seed 42/10k, 9170 events) captured reproducibility-first, != flags-off 3920accc; DET-03 ESLint guard bans Date.now/Math.random/async-queue/kysely in ooda/** (proven); TrailerDiverted canonicalized
- [Phase 25-01 COORD-02]: 3 advisory coordination events (ActionSuggested/SuggestionAccepted/SuggestionRejected) added to closed DomainEvent union + zod; all SCOPE-NEUTRAL in scope.ts; ActionSuggested pinned via canonicalizeSuggestionPayload (coordinator/canonical.ts). kind=reroute|hold|consolidate|dispatch, reasonCode=hos|fuel|dock|infeasible, integer/string-only params + integer sim-time ms (no RNG/float). Zero behavior change (flags-off golden 3920accc + OODA-on 94689f99 byte-identical); pnpm typecheck is the exhaustiveness proof (not vitest — esbuild strips types).
- [Phase 25-02 COORD-01/02]: in-fold `stepCoordinators` SimTask — one coordinator per center, sorted by centerId, bounded per-center scope, self-rescheduling (mirrors stepAgents). Rule-based `decideCoordinatorSuggestions` (pure, integer/string-only) for all 4 kinds into `pendingSuggestionsByTarget` (consumed P25-03, serialized P25-05). COORDINATOR_RNG_SALT=0x1c6ea54b (9th salt, pairwise-distinct, lazy `deriveCoordinatorRng` in pure coordinator/rng.ts leaf). Coordinator cadence==OODA cadence (5/1) + bootstrap-seeded BEFORE stepAgents ⇒ same-tick handshake. suggestionId=`centerId-tick-index` (byte-stable, collision-free); issuedAtSimMs=tick*MS_PER_TICK, ttlSimMs=6*MS_PER_TICK (TTL enforcement is P25-04). reroute needs activeTripByTrailer (OODA-on); all 4 kinds appear under all-on stack (hold/reroute/consolidate/dispatch). `coordinatorsEnabled` OFF (strict ===true) ⇒ no task/substream/emit, golden 3920accc + OODA-on 94689f99 byte-identical (two-part gate added).
- [Phase ?]: 26-02: stepCoordinators reroute sourced from per-center pure runEpoch under coordinatorUsesOptimizer sub-flag; hold/consolidate/dispatch stay rule-based (COORD-06)
- [Phase ?]: 26-02: partitionScopeByCenter (NET-05) wired LIVE as the per-center epoch scope; deterministic scope-size cap falls back to rule-based; global RollingLoop disabled under the flag (no double-plan)
- [Phase ?]: [Phase 26-03 COORD-06]: optimizer-on golden captured reproducibility-first = edfa5a6d (DOCUMENTED-EQUAL to the Phase-25 coordinator golden, planner-truth #2 amended/Option A): the optimizer is genuinely invoked (instrumented: 2000 runEpoch epochs / 9663 pre-guard reroutes / 0 fallbacks) but on the center-headed/always-feasible per-center twin it only ENDORSES the same reroute the rule-based heuristic makes => byte-identical on every config. coordinatorUsesOptimizer two-part flags-off gate (false===absent + absent=>edfa5a6d, 3920accc/94689f99 intact); continuation-equivalence chunked==all-at-once 1/7/23/500 with NO new SerializedWorldState field. No production change. Phase-27 carry-over: make the optimizer reroute genuinely route-aware-divergent + reject-with-reason continental tuning.

### Pending Todos

- [Phase 23 planning] Confirm dataset source (SimpleMaps vs `all-the-cities`) + attribution mechanics; cross-state-metro de-dup canonical-coordinate rules; confirm final center count (~5–6 default) + backbone density against a real continental run. (research/SUMMARY.md "Research Flags")
- [Phase 25 planning] The five anti-oscillation guards are well-specified but their **sim-time constants** (hysteresis dwell ~15 min, TTL ~5–8 min, cooldown K, lease expiry) need tuning + golden capture.
- [Phase 26 planning] Profile per-center twin-build cost vs the synchronous in-fold budget; keep a heuristic-Decide fallback behind the sub-flag if too heavy.
- [Phase 27] Resolve the vendored `@alexanderfedin/async-queue` `dist/` (commit `vendor/async-queue/dist/` recommended) + `vendor/*` workspace wiring + ESLint core-ban before any plumbing lands.

### Blockers/Concerns

blocking roadmap approval. Top risk carried into execution: **determinism keystone** — every phase must hold the two-part flags-off gate; the `applyHubInventory` O(n²) freeze (P1-BLOCKING, Phase 23) and the per-center coordinator oscillation/deadlock modes (Phase 25) are the first-class blockers flagged by PITFALLS.

- 26-03 Task 2: optimizer-backed coordinator golden is byte-identical to the Phase-25 edfa5a6d golden on EVERY config (single-center, continental, fleet 2/4/8). Verified via instrumentation: runEpoch IS invoked (2000 epochs, 9663 reroutes, 0 fallbacks) but endorses the exact same reroute set as the rule-based path. Root cause in Plan-02 wiring: the optimizer twin route head is structurally pinned to obs.centerId (same target the rule-based heuristic picks) AND the twin is built always-feasible/unfrozen so the optimizer never declines a reroute the rule flags. Plan truth #2 (!= edfa5a6d) is unachievable without changing Plan-02 production reroute semantics — Rule-4 architectural decision required.

### Quick Tasks Completed

| # | Description | Date | Commit | Status | Directory |
|---|-------------|------|--------|--------|-----------|
| 260621-0fy | UI speed-of-time gauge (live sim-speed control + clock fix) | 2026-06-21 | 1154ddd | Verified | [260621-0fy-sim-speed-gauge](./quick/260621-0fy-sim-speed-gauge/) |
| 260621-j57 | Seeded log-normal dwell + transit timing (realistic right-skew, deterministic) | 2026-06-21 | b52d762 | Done | [260621-lognormal-timing](./quick/260621-lognormal-timing/) |

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| v2.0 debt | Materialize the delivery-KPI projection before enabling event-log retention in a long run | Open | v2.0 close |
| v2.0 debt | Add one all-flags-on lifecycle integration test | Open | v2.0 close |

## Session Continuity

Last session: 2026-06-27T06:18:56.494Z
Stopped at: Phase 27 UI-SPEC approved
Resume file: .planning/phases/27-perf-plumbing-scale-viz/27-UI-SPEC.md

## Operator Next Steps

- Review the v3.0 roadmap (.planning/ROADMAP.md) + traceability (.planning/REQUIREMENTS.md)
- On approval, plan the foundation phase: `/gsd-plan-phase 23`
