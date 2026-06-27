---
phase: 25-coordination-centers
plan: 04
subsystem: simulation
tags: [coordination, determinism, anti-oscillation, anti-deadlock, anti-livelock, guards, hysteresis, backoff, ttl, lease, reject-pruning, seeded-rng, sim-time]

# Dependency graph
requires:
  - phase: 25-coordination-centers (plan 02)
    provides: "stepCoordinators in-fold pass + decideCoordinatorSuggestions (the candidate generator the guards filter) + deriveCoordinatorRng (the seeded-jitter substream) + COORDINATOR_TTL_SIM_MS stamp + pendingSuggestionsByTarget"
  - phase: 25-coordination-centers (plan 03)
    provides: "the same-tick accept/reject handshake (arbitrateSuggestion; SuggestionRejected emission) — the reject site the reject-pruning/backoff counters hook into; the hold-always-accepted feasible no-op (COORD-05 substrate)"
  - phase: 23-topology
    provides: "centerOf — the single-owner partition + the zone-change source that clears the prune"
provides:
  - "the FIVE anti-oscillation/anti-deadlock guards as PURE/sim-time/seeded predicates (coordinator/guards.ts): hysteresis dead-band, seeded-jitter exponential backoff, sim-time TTL, single-owner lease per agent, reject-path pruning"
  - "the NAMED sim-time constant envelope (coordinator/constants.ts): HYSTERESIS_DWELL_SIM_MS, SUGGESTION_TTL_SIM_MS, LEASE_SIM_MS, REJECT_COOLDOWN_K, BACKOFF_BASE/CAP/JITTER_SIM_MS"
  - "the guard FILTER wired into stepCoordinators (lease → reject-pruning → backoff → hysteresis, deterministic order, before emit) + lease acquisition on emit + per-pass hysteresis-marker advance + zone-change prune-clear"
  - "the reject-count + seeded-jitter-backoff advance wired into the stepAgents handshake (recordSuggestionReject) — closes the Pitfall-10 re-suggest loop"
  - "the in-engine guard STATE (leaseByAgent, rejectCountByOption, backoffUntilByOption, metricAboveSinceByOption, lastCenterByAgent) as plain serializable Maps (Plan 05 persists into SerializedWorldState)"
  - "the first-class adversarial stability suite (coordinator-stability.unit.test.ts): convergence (no A↔B↔A), bounded-events-per-tick plateau under all-reject, tick-closes, determinism"
affects: [25-05 coordinator-on golden capture (the guards' damped output is baked in) + continuation serialization of the guard state + coordinator/** ESLint purity guard]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "guard predicates as PURE reducer-style functions (state + nowSimMs (+ rng) -> suppress/allow decision and/or NEW state value, no mutation) — mirroring coordinator/** leaf discipline; the engine threads them between candidate generation and emit"
    - "in-engine guard STATE as plain Map<compositeKey, integer|lease> written ONLY on the coordinators-on path (every WRITE under the flag) so the flag-off golden is untouched — the same off-path-inertness pattern as pendingSuggestionsByTarget"
    - "seeded jitter from the per-CENTER deriveCoordinatorRng substream (never Math.random) so backoff timing stays byte-identical on replay (DET-03)"
    - "named sim-time constants as integral MS_PER_TICK multiples aligned to the coordinator cadence (dwell = 3 passes, TTL ≈ 1 pass, lease = 1 pass) — a guard window is always an integer number of passes"

key-files:
  created:
    - packages/simulation/src/coordinator/constants.ts
    - packages/simulation/src/coordinator/guards.ts
    - packages/simulation/src/coordinator/guards.unit.test.ts
    - packages/simulation/test/coordinator-stability.unit.test.ts
  modified:
    - packages/simulation/src/coordinator/index.ts
    - packages/simulation/src/engine.ts
    - packages/simulation/test/coordinator-engine.unit.test.ts

key-decisions:
  - "Named sim-time envelope (all integral MS_PER_TICK multiples): HYSTERESIS_DWELL_SIM_MS = 15×MS_PER_TICK (~15 sim-min = 3 coordinator passes of sustained breach), SUGGESTION_TTL_SIM_MS = 6×MS_PER_TICK (kept in lockstep with the Plan-02 COORDINATOR_TTL_SIM_MS stamp), LEASE_SIM_MS = 5×MS_PER_TICK (one pass), REJECT_COOLDOWN_K = 3, BACKOFF_BASE = 1×, BACKOFF_CAP = 30×, BACKOFF_JITTER = 1× MS_PER_TICK"
  - "Guard predicates are PURE + reducer-style: passesHysteresis/updateHysteresisMarker, nextBackoffUntil (BASE×2^(n-1) capped + seeded jitter)/inBackoff, isExpired, leaseAvailable/acquireLease, isPruned/recordReject/clearPruneOnZoneChange — each takes nowSimMs (never Date.now) and the backoff takes the seeded Rng (never Math.random)"
  - "Deterministic guard-filter ORDER in stepCoordinators: lease → reject-pruning → backoff → hysteresis; the surviving candidates get a SURVIVING-index suggestionId (`centerId-tick-survivingIndex`) and acquire the single-owner lease on emit; TTL applies to PENDING suggestions (expired on read), not fresh candidates"
  - "Hysteresis marker maintenance is per-(centerId,target,kind): a candidate that fires this pass ⇒ start/retain the dwell marker; an option with a prior marker under this center that did NOT fire ⇒ marker cleared (a transient breach that fell back resets the dwell)"
  - "Reject site (recordSuggestionReject in stepAgents) advances rejectCountByOption (toward the K-prune) AND sets nextBackoffUntil with jitter from the rejecting suggestion's OWN center substream — at nowSimMs = tick×MS_PER_TICK, the SAME sim-time the coordinator stamped (one shared clock)"
  - "Zone-change prune-clear: when a target this center is now scoping was last scoped by ANOTHER center (lastCenterByAgent change), its reject/backoff/hysteresis state for the prior center is cleared (the shift/zone-change cooldown reset, GUARD 5)"
  - "Guard state lives in plain in-engine Maps (leaseByAgent / rejectCountByOption / backoffUntilByOption / metricAboveSinceByOption / lastCenterByAgent) constructed unconditionally but WRITTEN only on the on-path; Plan 05 serializes them into SerializedWorldState for full continuation-equivalence"

patterns-established:
  - "purity check that strips block + line comments before grepping for Date.now/Math.random — a guard's doc comment legitimately NAMES the banned APIs to document the contract; only EXECUTABLE source must be clean"

requirements-completed: [COORD-04, COORD-05]

# Metrics
duration: 22min
completed: 2026-06-27
---

# Phase 25 Plan 04: Anti-Oscillation / Anti-Deadlock Guards + Anti-Livelock Stability Summary

**The FIVE anti-oscillation/anti-deadlock guards ship with the coordinator (COORD-04) — hysteresis dead-band (~15 sim-min dwell), seeded-jitter exponential backoff (jitter from `deriveCoordinatorRng`, never `Math.random`), sim-time TTL (~6 sim-min), single-owner lease per agent (~5 sim-min), and reject-path pruning (K=3) — all NAMED, sim-time, seeded, PURE; plus the anti-livelock proof (COORD-05): a fixed scenario CONVERGES with zero A↔B↔A oscillation, a persistently-rejected option re-fires ≤ K times (no Zeno), and every tick closes — flag-off seed-42 10k golden still `3920accc…`.**

## Performance

- **Duration:** ~22 min
- **Tasks:** 3 (Task 1 TDD RED→GREEN; Task 2 engine wiring with co-authored integration assertions; Task 3 TDD stability suite)
- **Files modified:** 7 (4 created, 3 modified)

## Accomplishments

- **The five guards as a pure, named, sim-time leaf (Task 1, COORD-04).** `coordinator/constants.ts` is the DESIGN-CONSULT Q2 envelope made concrete — every constant an integral `MS_PER_TICK` multiple aligned to the coordinator cadence (dwell = 3 passes, TTL ≈ 1 pass, lease = 1 pass). `coordinator/guards.ts` exports the five PURE reducer-style predicates: `passesHysteresis`/`updateHysteresisMarker` (GUARD 1), `nextBackoffUntil` (`BASE×2^(n-1)` capped + seeded jitter) / `inBackoff` (GUARD 2), `isExpired` (GUARD 3), `leaseAvailable`/`acquireLease` (GUARD 4), `isPruned`/`recordReject`/`clearPruneOnZoneChange` (GUARD 5). 24 unit tests prove each guard's suppress/allow/expire/lease/prune behavior + the monotonic-capped backoff + purity (no `Date.now`/`Math.random` in code).
- **The guard FILTER wired into `stepCoordinators` (Task 2, COORD-04).** After `decideCoordinatorSuggestions` produces candidates, each is filtered through the guards in a deterministic order — **lease → reject-pruning → backoff → hysteresis** — and only survivors are stamped (a surviving-index `suggestionId`) + emitted; on emit the coordinator acquires the single-owner lease on the target. Per-pass the hysteresis markers advance (fired ⇒ start/retain the dwell, fell-back ⇒ reset), and a `centerOf` zone change clears the prior center's prune/backoff/hysteresis for the moved agent.
- **The reject loop closed (Task 2, COORD-05).** `recordSuggestionReject` in the `stepAgents` handshake advances `rejectCountByOption` (toward the K-prune) AND sets a seeded-jitter exponential backoff (jitter from the rejecting suggestion's OWN center substream) so the NEXT coordinator pass suppresses the just-rejected option — this is what bounds events-per-tick under an all-reject scenario (Pitfall 10 Zeno).
- **The first-class adversarial stability suite (Task 3, COORD-04/05).** `coordinator-stability.unit.test.ts` (8 tests) proves with CONCRETE NUMBERS: **(a) convergence** — 0 oscillating targets (no value reappears after changing; no A↔B↔A), each trailer ≤ 1 distinct reroute destination; **(b) bounded events** — a persistently-rejected `(coordinator,target,kind)` option is re-suggested **≤ 3 (= K)** times (the plateau witness; without the guards it would re-fire every pass), suggestions/tick bounded by agent count; **(c) tick closes** — accepted + rejected == suggested for every tick, and an HOS-out all-reject run still returns a finite stream (the termination witness); **(d) determinism** — same-seed byte-identical, and total suggestions far below the un-damped `hubs × passes` floor (the guards damp the re-emit).
- **Determinism keystone HELD.** All guard state is sim-time/seeded/pure; every WRITE is under the `coordinatorsEnabled` flag, so `coordinatorsEnabled` off ⇒ the seed-42 10k golden is byte-identical to `3920accc…` and the OODA-on golden `94689f99…` is unchanged. The coordinator-on run is same-seed reproducible. The guards damped the natural all-on stack from 10,372 → 9,174 suggestions (the transient/short-lived breaches — e.g. `dispatch` — correctly suppressed by the hysteresis dwell).

## Task Commits

1. **Task 1 (TDD): named constant envelope + five pure guard predicates** — `7123340` (feat) — 24 unit tests GREEN; typecheck + lint clean
2. **Task 2: integrate the five guards into stepCoordinators + the handshake reject loop** — `39db0e8` (feat) — coordinator-engine 18 tests GREEN; flag-off golden still `3920accc…`; typecheck + lint clean
3. **Task 3 (TDD): anti-livelock + convergence stability suite** — `c206434` (test) — 8 stability tests GREEN; typecheck + lint clean

_Note: Task 1 + Task 3 followed RED→GREEN (the implementation co-authored with a failing-first test, verified GREEN before commit); Task 2 is engine wiring with co-authored integration assertions, committed at GREEN._

## Files Created/Modified

**Created:**
- `packages/simulation/src/coordinator/constants.ts` — the named sim-time envelope (HYSTERESIS_DWELL/SUGGESTION_TTL/LEASE_SIM_MS, REJECT_COOLDOWN_K, BACKOFF_BASE/CAP/JITTER_SIM_MS)
- `packages/simulation/src/coordinator/guards.ts` — the five pure/sim-time/seeded guard predicates (204 lines)
- `packages/simulation/src/coordinator/guards.unit.test.ts` — 24 tests (per-guard suppress/allow/expire/lease/prune, capped exponential backoff, seeded jitter, purity)
- `packages/simulation/test/coordinator-stability.unit.test.ts` — the 8-test adversarial stability suite (convergence / bounded-events / tick-closes / determinism)

**Modified:**
- `packages/simulation/src/coordinator/index.ts` — export the guard + constant surface
- `packages/simulation/src/engine.ts` — the guard imports; the guard STATE maps + `optionKey`; the guard filter + lease-on-emit + hysteresis-marker advance + zone-change clear in `stepCoordinators`; `recordSuggestionReject` in `stepAgents`; the reject branches call it (truck + hub)
- `packages/simulation/test/coordinator-engine.unit.test.ts` — the "all 4 kinds" engine assertion updated to "the SUSTAINED kinds surviving the hysteresis dead-band" (the all-4-kinds generation proof lives in `coordinator.unit.test.ts`)

## Decisions Made

See `key-decisions` frontmatter. Highlights: the named sim-time envelope as cadence-aligned `MS_PER_TICK` multiples; pure reducer-style guard predicates (nowSimMs + seeded Rng, never `Date.now`/`Math.random`); the deterministic lease→prune→backoff→hysteresis filter order with surviving-index suggestionIds + lease-on-emit; per-(center,target,kind) hysteresis-marker maintenance; the reject site advancing prune + seeded backoff at the shared `tick×MS_PER_TICK` clock; zone-change prune-clear; guard state in plain Maps written only on the on-path (Plan 05 serializes them).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Purity check matched the banned API names in doc comments**
- **Found during:** Task 1 (the guards purity unit test)
- **Issue:** The structural `expect(src).not.toMatch(/Date\.now/)` check failed because `guards.ts`'s doc comments legitimately NAME `Date.now`/`Math.random` to document the determinism contract ("…never `Math.random`…").
- **Fix:** The purity test now strips block (`/* … */`) and line (`// …`) comments before matching, so only EXECUTABLE source is checked — the precise structural witness the ESLint guard (Plan 05) will enforce.
- **Files modified:** `packages/simulation/src/coordinator/guards.unit.test.ts`
- **Commit:** `7123340` (with Task 1)

**2. [Rule 1 - Bug] The prior "all 4 kinds" engine assertion no longer holds with hysteresis on**
- **Found during:** Task 2 (running the existing coordinator-engine integration test)
- **Issue:** With the hysteresis dead-band active, the rare `dispatch` kind (only 4 emitted across the whole 6000-tick run pre-guards, never sustained for the ~15-sim-min dwell) is correctly SUPPRESSED — so the engine-level "generates ALL FOUR kinds" assertion failed. This is the guard doing its job (an intended behavior change), not a logic gap: the all-four-kinds property belongs to the pre-guard GENERATION layer, already proven in `coordinator.unit.test.ts`.
- **Fix:** Updated the engine-level assertion to "the SUSTAINED kinds surviving the hysteresis dead-band" (reroute + hold + consolidate persist; every emitted kind is one of the four closed kinds), documenting that transient dispatch is correctly damped.
- **Files modified:** `packages/simulation/test/coordinator-engine.unit.test.ts`
- **Commit:** `39db0e8` (with Task 2)

**Total deviations:** 2 auto-fixed (both Rule 1 bugs in tests, not in the engine logic). No Rule 4 architectural decisions were needed — the guard state shape, filter order, and constant values were all within the plan's Claude's-Discretion scope.

## Issues Encountered

- **All-reject is naturally rare in the demo stack.** Forcing `maxDriveMin: 1` (HOS-out) did NOT make every suggestion reject — most reroutes still land on trucks with no binding constraint and `hold` is always accepted, so the explicit all-reject scenario yields a small reject count. The Zeno/livelock witness is therefore expressed precisely as "an option that is EVER rejected and NEVER accepted is re-suggested ≤ K times" (the plateau) — which the natural all-on stack exhibits cleanly (5 such options, each re-suggested ≤ 3 times). The HOS-out scenario still serves as the tick-closes/termination witness (a finite returned stream).

## Known Stubs

None that prevent the plan goal. The guard STATE (lease/reject-count/backoff/hysteresis/last-center Maps) lives in in-engine Maps this plan; SERIALIZING them into `SerializedWorldState` for full continuation-equivalence is Plan 05 (explicitly downstream, by the plan's own scope note). The `coordinator/**` ESLint purity guard is Plan 05 (the leaf is already pure — proven structurally by the guards purity test here).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- **Plan 05** must: (1) serialize the guard state (`leaseByAgent`, `rejectCountByOption`, `backoffUntilByOption`, `metricAboveSinceByOption`, `lastCenterByAgent`) + `pendingSuggestionsByTarget` into `SerializedWorldState` for continuation-equivalence; (2) capture the coordinator-on golden (reproducibility-first) — the guards' damped output (9,174 suggestions on the seed-42 all-on stack) is what gets baked in; (3) extend the canonical salt-collision Set to size 10; (4) add the `coordinator/**` ESLint purity guard (the whole leaf is already pure, including the new `guards.ts`/`constants.ts`).
- No blockers. Determinism keystone held: flag-off `3920accc…` + OODA-on `94689f99…` byte-identical; coordinator-on same-seed reproducible; `pnpm typecheck` + `pnpm --filter @mm/simulation lint` clean; 539 simulation + 260 domain unit tests GREEN.

## Threat Surface Scan

The plan's `<threat_model>` threats are all MITIGATED (no new surface introduced):
- **T-25-13 (DoS / advisory-reject Zeno)** — mitigated by reject-path pruning (K=3) + backoff + the bounded-events-per-tick plateau test (≤ K re-suggestions).
- **T-25-14 (DoS / suggestion oscillation)** — mitigated by the hysteresis dead-band + the converges-in-K / no-A↔B↔A test (0 oscillating targets).
- **T-25-15 (EoP / conflicting coordinators on one agent)** — mitigated by the single-owner lease + the centerOf partition.
- **T-25-16 (Tampering / guard jitter determinism)** — mitigated by backoff jitter from `deriveCoordinatorRng` (seeded, never `Math.random`); same-seed byte-identical proven.
- **T-25-17 (DoS / stale suggestion acted on)** — mitigated by the sim-time TTL (`isExpired`).

No threat flags — the guards add NO new network endpoint, auth path, file access, or schema change; the new state is in-process and the new payloads reuse the Plan-01 canonicalized `ActionSuggested`.

## Self-Check: PASSED

- Created files verified on disk (constants.ts, guards.ts, guards.unit.test.ts, coordinator-stability.unit.test.ts)
- Task commits verified in git log (`7123340`, `39db0e8`, `c206434`)
- Gates: `pnpm typecheck` CLEAN; `pnpm --filter @mm/simulation lint` exit 0; 539 simulation unit + 260 domain unit tests GREEN; determinism keystone — flag-off seed-42 10k golden `3920accc…` (24 determinism tests pass); coordinator-on same-seed byte-identical; the convergence (0 oscillating) + bounded-events (≤ K plateau) + tick-closes results asserted with concrete numeric thresholds

---
*Phase: 25-coordination-centers*
*Completed: 2026-06-27*
