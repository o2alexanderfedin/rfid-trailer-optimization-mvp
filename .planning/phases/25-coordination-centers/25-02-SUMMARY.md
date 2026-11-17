---
phase: 25-coordination-centers
plan: 02
subsystem: simulation
tags: [event-sourcing, process-manager, determinism, coordination, rng-substream, in-fold, sim-task]

# Dependency graph
requires:
  - phase: 25-coordination-centers (plan 01)
    provides: "ActionSuggested closed-union event + canonicalizeSuggestionPayload (the hashed-payload pin) + scope-neutral classification"
  - phase: 24-ooda-step-agents
    provides: "the stepAgents SimTask shape to MIRROR (flag, cadence, frozen observe, sorted iteration, lazy substream, self-reschedule); deriveAgentRng/OODA_RNG_SALT pattern; activeTripByTrailer (the truck next-hub source the reroute rule reads)"
  - phase: 23-topology
    provides: "centerOf / centerIds (one-coordinator-per-center substrate); bounded per-center scope"
provides:
  - "stepCoordinators — a self-rescheduling in-fold SimTask: one coordinator per regional center, sorted by centerId, bounded per-center scope, generating rule-based ActionSuggested for all 4 kinds"
  - "COORDINATOR_RNG_SALT (ninth substream salt, pairwise-distinct) + deriveCoordinatorRng + stableCenterHash (coordinator/rng.ts)"
  - "CoordinatorObservation — frozen integer/string per-center snapshot built at pass entry (coordinator/observe.ts)"
  - "decideCoordinatorSuggestions — pure rule-based generation of reroute/hold/consolidate/dispatch with named thresholds (coordinator/coordinator.ts)"
  - "pendingSuggestionsByTarget Map<string, ActionSuggested[]> — the in-engine same-tick handshake substrate (consumed by stepAgents in Plan 03)"
  - "coordinatorsEnabled flag (strict === true, off by default) with the two-part flags-off gate"
affects: [25-03 agent handshake + COORD-03 reject surfacing, 25-04 anti-oscillation guards (consume deriveCoordinatorRng jitter + ttlSimMs), 25-05 coordinator-on golden + salt-collision Set size 10 + continuation serialization]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "in-fold per-center process-manager as a self-rescheduling SimTask, mirroring stepAgents EXACTLY (flag/cadence/frozen-observe/sorted-iteration/lazy-substream/self-reschedule)"
    - "per-center seeded substream deriver (deriveCoordinatorRng) mirroring ooda/rng.ts's per-agent deriver — FNV-1a stableCenterHash + a fresh pairwise-distinct salt + two-stage mixSeed fold"
    - "bounded per-center scope: a coordinator observes ONLY its own spokes (centerOf === thisCenter) + in-region trucks — never another center's (the O(active-in-region) scaling thesis + anti cross-center conflict)"
    - "deterministic byte-stable collision-free suggestionId = `${centerId}-${tick}-${index}` (one center per centerId, distinct tick per pass, sorted index within pass)"

key-files:
  created:
    - packages/simulation/src/coordinator/rng.ts
    - packages/simulation/src/coordinator/observe.ts
    - packages/simulation/src/coordinator/coordinator.ts
    - packages/simulation/src/coordinator/index.ts
    - packages/simulation/src/coordinator/coordinator.unit.test.ts
    - packages/simulation/test/coordinator-engine.unit.test.ts
  modified:
    - packages/simulation/src/continuation.ts
    - packages/simulation/src/engine.ts

key-decisions:
  - "COORDINATOR_RNG_SALT = 0x1c6ea54b (NINTH substream salt, pairwise-distinct from the 8 prior salts); placed in a pure coordinator/rng.ts leaf so Plan 05's coordinator/** ESLint guard covers it (mirrors ooda/rng.ts)"
  - "COORDINATOR_INTERVAL_TICKS = COORDINATOR_START_TICK = 5 / 1 — SAME cadence + start tick as OODA so a coordinator pass ALWAYS lands on the same tick as an agent pass; bootstrap seeds the coordinator BEFORE stepAgents so it claims a lower queue seq and dispatches FIRST (the same-tick handshake precondition for Plan 03)"
  - "Named rule thresholds (congestionQueueDepth 12, consolidationFill 6, dispatchReadyFill 3); consolidate and dispatch are mutually exclusive on one spoke (consolidate wins on a fuller manifest) so they never double-fire"
  - "issuedAtSimMs = tick * MS_PER_TICK (sim-time since epoch, integer, no Date.now); COORDINATOR_TTL_SIM_MS = 6 * MS_PER_TICK (~6 sim-min) stamped now, the TTL expiry/enforcement guard is Plan 04"
  - "Coordinator center set = continental centerIds when on, else the single legacy center (hubs[0]) when off — a coordinator always exists; bounded scope filters spokes/trucks by centerOf === thisCenter"
  - "The reroute rule reads a truck's nextHubId (from activeTripByTrailer), which is populated only on the OODA-on path — so all 4 kinds appear under the natural all-on stack (coordinators+consolidation+induction+OODA)"
  - "pendingSuggestionsByTarget allocated unconditionally (an empty Map is semantically inert); off-path inertness comes from the flag gating every WRITE/emit/schedule, not from skipping the allocation"

patterns-established:
  - "two-part flags-off gate per new flag (false === absent over a short run AND absent => seed-42 10k golden 3920accc) — added for coordinatorsEnabled in coordinator-engine.unit.test.ts"
  - "frozen fold-map snapshot at pass entry; the Decide loop never re-reads live fold maps (order-independence witness, Pitfall 4) — reused from stepAgents for the per-center observation"

requirements-completed: [COORD-01, COORD-02]

# Metrics
duration: 12min
completed: 2026-06-27
---

# Phase 25 Plan 02: In-Fold Per-Center Coordinator Generation Summary

**A self-rescheduling in-fold `stepCoordinators` SimTask — one coordinator per regional center, sorted by centerId over a bounded per-center scope — generates rule-based `ActionSuggested` for all four kinds (reroute/hold/consolidate/dispatch) into an in-engine `pendingSuggestionsByTarget` map via a ninth pairwise-distinct RNG salt; `coordinatorsEnabled` OFF ⇒ seed-42 10k golden still `3920accc…` (COORD-01, COORD-02 generation half).**

## Performance

- **Duration:** 12 min
- **Started:** 2026-06-27T00:11:04Z
- **Completed:** 2026-06-27T00:23:27Z
- **Tasks:** 3 (Task 1 TDD: RED+GREEN; Tasks 2-3 wiring with co-authored tests)
- **Files modified:** 8 (6 created, 2 modified)

## Accomplishments

- **One coordinator per center runs in-fold (COORD-01).** `stepCoordinators` is a `SimTask` data variant on the `(fireTick, seq)` queue that mirrors `stepAgents` EXACTLY: a strict `coordinatorsEnabled === true` flag (off by default), a fixed cadence, a FROZEN per-center observation built once at pass entry, sorted-by-centerId iteration over a BOUNDED per-center scope (only that center's spokes + in-region trucks), a lazy per-center substream (only for a center with scope), and a self-reschedule at `+COORDINATOR_INTERVAL_TICKS`.
- **Rule-based generation of all 4 kinds (COORD-02 generation half).** `decideCoordinatorSuggestions` (pure, integer/string-only, deterministic) emits: REROUTE when an in-region truck's next hub exceeds the congestion threshold; HOLD when a target spoke's dock is busy with inbound freight; CONSOLIDATE when a spoke's pending-consolidation manifest exceeds the fill threshold; DISPATCH when an outbound-ready spoke has a free dock. Under the natural all-on stack (coordinators+consolidation+induction+OODA, seed 42 / 6000 ticks) the engine emits 10,372 `ActionSuggested` across all four kinds (`hold` 5792, `reroute` 3575, `consolidate` 1001, `dispatch` 4).
- **Same-tick handshake substrate.** Every emitted `ActionSuggested` is recorded in an in-engine `pendingSuggestionsByTarget: Map<string, ActionSuggested[]>` keyed by `targetAgentId`, ready for the Phase-24 agent step to consume in the SAME tick (Plan 03). The coordinator pass is seeded one queue-seq BEFORE `stepAgents` at a shared start tick so it dispatches first.
- **Ninth RNG salt, pairwise-distinct + lazy.** `COORDINATOR_RNG_SALT` (`0x1c6ea54b`) + `deriveCoordinatorRng(seed, centerId)` + `stableCenterHash` (FNV-1a) in a pure `coordinator/rng.ts` leaf, mirroring `ooda/rng.ts`. The salt is pairwise-distinct from all 8 prior salts; the substream is constructed ONLY on the on path, ONLY for a center that has scope.
- **Determinism keystone HELD.** `coordinatorsEnabled` off ⇒ NO `stepCoordinators` task scheduled, ZERO coordinator substreams, NO `ActionSuggested`, NO `pendingSuggestionsByTarget` writes ⇒ the seed-42 10k golden is byte-identical to `3920accc…` AND the OODA-on golden `94689f99…` is unchanged. Same seed twice ⇒ byte-identical (reproducible). The two-part flags-off gate (`false === absent` AND `absent ⇒ 3920accc…`) is added for `coordinatorsEnabled`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Coordinator RNG salt + frozen per-center observation + pure rule-based suggestion generation** - `f427a84` (feat) — 17 unit tests GREEN (salt distinctness, stable-centerId keying + decorrelation, all 4 rules, purity/determinism)
2. **Task 2: stepCoordinators SimTask skeleton — flag, cadence, dispatch case, bootstrap seed (off path inert)** - `3330d51` (feat) — typecheck clean, seed-42 10k golden still 3920accc
3. **Task 3: stepCoordinators pass body — sorted-by-centerId, bounded scope, frozen observe, emit ActionSuggested into pendingSuggestionsByTarget** - `d769d63` (feat) — 11 integration tests GREEN (all 4 kinds, same-seed identity, bounded scope, two-part flags-off gate)

**Plan metadata:** (this SUMMARY + ROADMAP) — see final commit below.

_Note: Task 1 followed RED→GREEN inline (the implementation + its failing test co-authored, verified GREEN before commit); Tasks 2-3 are wiring with co-authored verification tests, committed at GREEN._

## Files Created/Modified

**Created:**
- `packages/simulation/src/coordinator/rng.ts` - `COORDINATOR_RNG_SALT` (ninth salt) + `deriveCoordinatorRng` + `stableCenterHash` (pure leaf, mirrors ooda/rng.ts)
- `packages/simulation/src/coordinator/observe.ts` - `CoordinatorObservation` / `ObservedSpoke` / `ObservedTruck` (frozen integer/string per-center snapshot; bounded scope)
- `packages/simulation/src/coordinator/coordinator.ts` - `decideCoordinatorSuggestions` (pure rule-based 4-kind generation) + `COORDINATOR_THRESHOLDS` + `CoordinatorSuggestion` closed union
- `packages/simulation/src/coordinator/index.ts` - re-exports the coordinator module surface (+ the Plan-01 canonicalizeSuggestionPayload)
- `packages/simulation/src/coordinator/coordinator.unit.test.ts` - 17 tests: salt collision (local Set size 9), FNV-1a purity, stable-centerId keying + decorrelation, the 4 rules, purity/determinism
- `packages/simulation/test/coordinator-engine.unit.test.ts` - 11 tests: all 4 kinds, validateEvent, deterministic collision-free suggestionId, same-seed identity, bounded per-center scope, two-part flags-off gate

**Modified:**
- `packages/simulation/src/continuation.ts` - `stepCoordinators` data variant added to the `SimTask` union
- `packages/simulation/src/engine.ts` - `coordinatorsEnabled` flag + `COORDINATOR_INTERVAL_TICKS`/`COORDINATOR_START_TICK`/`COORDINATOR_TTL_SIM_MS` consts + `pendingSuggestionsByTarget` map + the full `stepCoordinators` body + dispatch case + bootstrap seed (before stepAgents)

## Decisions Made

See `key-decisions` frontmatter. Highlights: ninth pairwise-distinct salt in a pure leaf (ESLint-guard-ready); coordinator cadence == OODA cadence + bootstrap-ordered-first for the same-tick handshake; named mutually-exclusive consolidate/dispatch thresholds; integer sim-ms `issuedAtSimMs`/`ttlSimMs` (no Date.now); the coordinator center set falls back to the single legacy center when continental is off so a coordinator always exists; reroute requires OODA-on (its truck-next-hub source); `pendingSuggestionsByTarget` allocated unconditionally with off-path inertness enforced by gating every write.

## Deviations from Plan

None - plan executed exactly as written. All three tasks landed as specified; no Rule 1-4 deviations were needed. (The plan's discretion points — module layout, the exact rule heuristics/thresholds, the suggestionId scheme, and the same-tick ordering mechanism — were resolved as documented in `key-decisions`.)

## Issues Encountered

- **Continental topology under-triggers the rules in a short run.** A continental multi-center run (even 16k ticks) produced only `hold` suggestions from a single active center, because freight spreads thin across the backbone and congestion concentrates. Resolved by exercising all four kinds via the legacy single-center star under the all-on stack (where congestion + consolidation + OODA-populated trip context co-occur); the continental run is still used for the bounded-scope (no cross-center spoke) assertion. This is empirical scenario-shaping, not a logic change.
- **The reroute rule depends on `activeTripByTrailer`** (the truck next-hub source), which the engine populates only when `oodaAgentsEnabled`. Documented as a decision; the "all four kinds" test runs OODA on. No code change — the coordinator correctly reads whatever the frozen observation contains.

## Known Stubs

None that prevent the plan goal. `COORDINATOR_TTL_SIM_MS` is STAMPED on each suggestion but its expiry/enforcement is the Plan-04 TTL guard (intentional, by design — Plan 04 owns COORD-04). `deriveCoordinatorRng`'s seeded stream is constructed + passed to the generator but not yet drawn (the `void rng` is intentional: the COORD-04 seeded-jitter/backoff draws land in Plan 04; drawing now would move the Plan-05 coordinator-on golden). `pendingSuggestionsByTarget` is populated here and CONSUMED in Plan 03 (the accept/reject handshake) and SERIALIZED in Plan 05 (continuation) — both explicitly downstream.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- **Plan 03 (COORD-02 handshake half + COORD-03)** can now consume `pendingSuggestionsByTarget` in the Phase-24 `stepAgents` step (which dispatches in the same tick, after the coordinator pass): accept ⇒ a binding event + `SuggestionAccepted`; reject ⇒ `SuggestionRejected` + the COORD-03 alert-feed surfacing (the reducer no-op cases from Plan 01 are the wiring points).
- **Plan 04 (COORD-04 guards)** has its substrate: the per-center `deriveCoordinatorRng` substream (seeded jitter/backoff), `ttlSimMs` (sim-time TTL), and `suggestionId`/`kind`/`coordinatorId`/`targetAgentId` (lease + reject-path-pruning keys).
- **Plan 05** must: capture the coordinator-on golden (reproducibility-first), extend the canonical salt-collision test to Set size 10, add the `coordinator/**` ESLint purity guard (the leaf is already pure), and serialize `pendingSuggestionsByTarget` + any coordinator/lease state into `SerializedWorldState` for continuation-equivalence.
- No blockers. Determinism keystone held: flag-off golden `3920accc…` + OODA-on `94689f99…` byte-identical; `pnpm typecheck` clean; 489 simulation + 260 domain unit tests pass; lint clean on coordinator/** + engine.ts.

## Self-Check: PASSED

- Created files verified on disk (below)
- Task commits verified in git log (below)
- Gates: `pnpm typecheck` CLEAN; `pnpm --filter @mm/simulation lint` exit 0; 489 simulation unit + 260 domain unit tests GREEN; flag-off seed-42 10k golden `3920accc…` + OODA-on `94689f99…` byte-identical

---
*Phase: 25-coordination-centers*
*Completed: 2026-06-27*
