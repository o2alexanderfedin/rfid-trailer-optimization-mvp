---
phase: 24-ooda-step-agents
plan: 01
subsystem: simulation
tags: [ooda, determinism, fnv-1a, seeded-rng, domain-event, zod, tdd]

# Dependency graph
requires:
  - phase: 23-multi-center-topology
    provides: "centerOf / multi-center assignment the truck observation reads (assignedCenterId)"
  - phase: SP2-rest-fuel-stops
    provides: "TruckRested / TruckRefueled events the truck Decide's rest/refuel outcomes map to"
provides:
  - "OODA per-agent seeded substream: stableAgentHash (FNV-1a) + deriveAgentRng + OODA_RNG_SALT (OODA-04 / DET-03)"
  - "sortAgentsByStableId — the order-independence iteration primitive (OODA-04)"
  - "AgentObservation frozen, integer/string-only truck snapshot + TruckDecision closed union (OODA-04)"
  - "decideTruck — pure, deterministic Observe->Orient->Decide priority ladder (OODA-01)"
  - "New TrailerDiverted domain event threaded through the closed union + zod + every exhaustive switch (OODA-01)"
affects: [24-02-truck-hub-wiring, 24-03-hub-agent, 24-04-determinism-guard, 25-coordinators]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-agent seeded substream from the STABLE id via two-stage mixSeed over FNV-1a (eighth salt, lazy)"
    - "Sorted-by-stable-id deterministic agent iteration (shuffle-then-sort byte-identical witness)"
    - "Frozen, integer/string-only observation surface consumed by a pure Decide (no Date.now/Math.random)"
    - "New domain event threaded through ALL 15 exhaustive switches + the discriminator-count test (the Phase-22 typecheck trap)"

key-files:
  created:
    - packages/simulation/src/ooda/rng.ts
    - packages/simulation/src/ooda/agent.ts
    - packages/simulation/src/ooda/observe.ts
    - packages/simulation/src/ooda/truck.ts
    - packages/simulation/src/ooda/index.ts
    - packages/simulation/src/ooda/rng.unit.test.ts
    - packages/simulation/src/ooda/agent.unit.test.ts
    - packages/simulation/src/ooda/truck.unit.test.ts
    - packages/domain/src/events/trailer-diverted.test.ts
  modified:
    - packages/simulation/src/rng.ts
    - packages/simulation/src/index.ts
    - packages/domain/src/events/schemas.ts
    - packages/domain/src/events/domain-event.ts
    - packages/domain/src/events/index.ts
    - packages/domain/src/events/contract.assert.ts
    - packages/domain/src/index.ts
    - packages/domain/test/events.unit.test.ts
    - "packages/projections/src/reducers/*.ts (12 reducers) + runner/inline.ts"
    - packages/optimizer/src/rolling/scope.ts

key-decisions:
  - "OODA_RNG_SALT = 0x7a9e3f1d (eighth substream salt, pairwise-distinct from the 7 engine salts)"
  - "deriveAgentRng = makeRngFromState(mixSeed(mixSeed(seed) ^ OODA_RNG_SALT ^ stableAgentHash(id)))"
  - "TrailerDiverted payload = { trailerId, tripId, fromHubId, toHubId, reason, occurredAt } — ids + clock only, NO geo/RNG"
  - "Truck Decide priority ladder: rest > refuel > divert > hold > proceed (binding feasibility first)"
  - "Threaded TrailerDiverted as a no-op/audit case in every exhaustive switch (additive, no behavior change in 24-01)"

patterns-established:
  - "Pattern: per-agent substream keyed on the STABLE id (never spawn index / array position), lazily constructed"
  - "Pattern: shuffle-then-sort-by-stable-id as the strongest determinism witness"
  - "Pattern: pure Decide over a frozen observation, single rng draw for the divert tie-break"

requirements-completed: [OODA-01, OODA-04, DET-03]

# Metrics
duration: 13min
completed: 2026-06-26
---

# Phase 24 Plan 01: OODA Scaffolding + Truck Decide + TrailerDiverted Summary

**Deterministic OODA decision-core leaf: FNV-1a `stableAgentHash` + lazy per-agent seeded substream (`OODA_RNG_SALT` 0x7a9e3f1d), sorted-by-stable-id iteration, a frozen integer/string truck observation, a pure `decideTruck` priority ladder, and a new `TrailerDiverted` domain event threaded through the closed union + zod + all 15 exhaustive switches.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-06-26T22:10:05Z
- **Completed:** 2026-06-26T22:23:02Z
- **Tasks:** 3
- **Files modified:** 31 (across 3 atomic commits)

## Accomplishments

- **OODA-04 determinism primitives** (`ooda/rng.ts`, `ooda/agent.ts`, `ooda/observe.ts`):
  - `stableAgentHash(id)` — 32-bit FNV-1a digest of the STABLE agent id (mirrors `centers.ts`'s `partitionChecksum` exactly).
  - `OODA_RNG_SALT = 0x7a9e3f1d` — the eighth substream salt, asserted pairwise-distinct from the seven engine salts (Set size 8).
  - `deriveAgentRng(seed, id)` — two-stage `mixSeed(mixSeed(seed) ^ salt ^ hash(id))` substream; N=64/K=8 decorrelation proven (no two agents share their first-K draws). Lazy by contract (flag-off allocates nothing). `mixSeed` exported additively from `rng.ts` (zero behavior change).
  - `sortAgentsByStableId` — pure codepoint-ordered copy; shuffle-then-sort is byte-identical (the order-independence witness).
  - `AgentObservation` — frozen, integer/string-only truck snapshot (no float geometry, no live refs); `TruckDecision` closed proceed|divert|rest|refuel|hold union.
- **OODA-01 truck Decide** (`ooda/truck.ts`): `decideTruck(obs, rng)` is pure + deterministic with a documented priority ladder (rest > refuel > divert > hold > proceed); the divert hub is the ONLY rng draw, pulled from the per-agent substream.
- **New `TrailerDiverted` event** threaded end-to-end through `@mm/domain` and every consumer; `pnpm typecheck` is the gate that proves it (vitest alone would pass with a missing switch case — the Phase-22 trap).
- **DET-03 foundation:** the `ooda/` package is a pure, synchronous, import-restricted leaf — imports only `../rng.js` + `@mm/domain` types; no `Date.now`/`Math.random`/async. The seed-42 golden stays byte-identical (`3920accc…`).

## Task Commits

Each task was committed atomically (RED test ran failing first, then GREEN implementation, per the plan's `type: tdd` discipline):

1. **Task 1: OODA RNG primitives (stableAgentHash + deriveAgentRng + OODA_RNG_SALT)** — `4432551` (feat)
2. **Task 2: Agent + frozen observation + sorted-by-stable-id** — `5b9c2b7` (feat)
3. **Task 3: New TrailerDiverted event + pure truck Decide** — `fd1e998` (feat)

**Plan metadata:** _(this SUMMARY + STATE/ROADMAP)_ — committed separately.

## TrailerDiverted Payload Shape

```
{ type: "TrailerDiverted", schemaVersion: 1,
  payload: { trailerId, tripId, fromHubId, toHubId,
             reason: "next-hub-congested" | "next-hub-blocked" | "rebalance",
             occurredAt } }
```

Ids + a domain-clock string only — NO lon/lat, NO RNG value (geometry-free; T-24-02 anti-repudiation carries `reason` + `tripId` + from/to hubs for a replayable audit trail).

## Truck Decide Priority Ladder

1. **rest** — `remainingLegalDriveMinutes <= 0` ⇒ `rest-10h` (600 min); `minutesSinceLastBreak >= 480` ⇒ `break-30min` (HOS is the hard, binding legal constraint — highest priority, beats refuel).
2. **refuel** — `odometerMiles >= 1200` (mirrors `DEFAULT_FUEL_CONFIG.refuelThresholdMiles`) and legal to drive.
3. **divert** — `nextHubQueueDepth > 50` and an alternate hub exists ⇒ pick an alternate from the per-agent substream (the ONLY rng draw); the chosen hub is always different from `nextHubId`.
4. **hold** — no trip (`no-trip`), or dock unavailable with a manageable queue (`dock-unavailable`).
5. **proceed** — feasible, uncongested, dock free (no event).

## Exhaustive Switches Threaded (the TrailerDiverted member)

Closed-union surface (`@mm/domain`): `schemas.ts` (`trailerDivertedSchema` + `domainEventSchema` array), `domain-event.ts` (type + `DomainEvent` union), `events/index.ts` + main `index.ts` re-exports, `contract.assert.ts` (the build-gating exhaustiveness + type-equality proof), `events.unit.test.ts` (describeEvent case + the 25→26 discriminator-count test).

Reducer/consumer switches (15 total, all additive no-op/audit cases): `optimizer/src/rolling/scope.ts`; `projections/src/reducers/` — `audit-timeline`, `geo-track`, `delivery-kpi`, `driver-assignment`, `driver-status`, `exceptions`, `hub-inventory`, `package-location`, `tag-registry`, `trailer-fuel`, `trailer-state`, `zone-estimate`; and `projections/src/runner/inline.ts`.

## Decisions Made

- **OODA_RNG_SALT = `0x7a9e3f1d`** — picked as a fresh, well-separated (every-byte-distinct) uint32; the salt-collision test asserts it differs from RFID/OVER_CARRY/TIMING/HOS/FUEL/INDUCTION/OUTBOUND.
- **Divert alternates are a fixed stable roster in 24-01** — the pure Decide is standalone here; 24-02's engine wiring supplies the real route-aware alternates. Keeps the decision deterministic and testable now.
- **TrailerDiverted is a no-op/audit case in every switch this plan** — the actual re-route geometry/inventory effects land in 24-02; 24-01 keeps the build green and the flag-off golden byte-identical.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Salt-collision test asserted the wrong Set size (9 vs 8)**
- **Found during:** Task 1 (OODA RNG primitives)
- **Issue:** The plan/CONTEXT referenced "~8 existing salts," but the engine exports exactly SEVEN substream salts (RFID/OVER_CARRY/TIMING/HOS/FUEL/INDUCTION/OUTBOUND). My RED test asserted `Set([...7 engine, OODA]).size === 9`, which is impossible (8 values).
- **Fix:** Corrected the assertion to `Set size 8` (7 engine + OODA) and aligned the comment + the OODA_RNG_SALT doc-comment to "eighth salt."
- **Files modified:** packages/simulation/src/ooda/rng.unit.test.ts, packages/simulation/src/ooda/rng.ts
- **Verification:** All 9 rng tests pass; the salt is genuinely pairwise-distinct.
- **Committed in:** 4432551 (Task 1 commit)

**2. [Rule 3 - Blocking] `JSON.parse`/`JSON.stringify` no-mutation snapshot tripped the no-`any` lint rule**
- **Found during:** Task 3 (truck Decide test) — surfaced by `pnpm lint`
- **Issue:** `JSON.parse(JSON.stringify(obs))` returns `any`, violating `@typescript-eslint/no-unsafe-assignment` (the project's strict no-`any` mandate).
- **Fix:** Replaced with a typed `structuredClone(baseObs)` snapshot.
- **Files modified:** packages/simulation/src/ooda/truck.unit.test.ts
- **Verification:** `pnpm lint` clean (exit 0); the no-mutation test still passes.
- **Committed in:** fd1e998 (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both were small test-side corrections necessary for correctness/lint compliance. No scope creep; the implementation matches the plan exactly.

## TDD Gate Compliance

Plan is `type: tdd`. Each task followed RED→GREEN: the RED test was written first and run to confirm failure (module-not-found / `validateEvent` rejecting a valid event because the schema wasn't in the union yet — the esbuild-strips-types behavior that is exactly why `pnpm typecheck` is the real exhaustiveness gate), then the GREEN implementation made it pass. Per-task commits combine the RED test + GREEN implementation into a single `feat(...)` commit (rather than separate `test(...)` then `feat(...)` commits), since each plan task bundles its tests with its code. RED was verified manually in-session before each GREEN. No REFACTOR commits were needed.

## Issues Encountered

- The domain RED test initially showed `trailerDivertedSchema` undefined at runtime even after adding it to `events/schemas.ts` + `events/index.ts` — because the test imports from the package's MAIN `index.ts`, which also needed the type + schema re-export. Resolved by threading the re-export through `packages/domain/src/index.ts`.

## Next Phase Readiness

- The OODA decision-core contract (per-agent substream, sorted-by-stable-id, frozen observation, `decideTruck`, `TrailerDiverted`) is ready for **24-02** to wire into the engine (the `stepAgents` SimTask + `oodaAgentsEnabled` flag + centralized-decision bypass) and capture the OODA-on golden.
- **24-04** will add the DET-03 static guard (`no-restricted-imports` for `Date.now`/`Math.random`/async-queue in the OODA packages); the surface is already clean for it.
- No blockers. The flag-off seed-42 golden remains byte-identical (`3920accc…`).

## Self-Check: PASSED

All 9 created files exist on disk; all 3 task commits (`4432551`, `5b9c2b7`, `fd1e998`) are present in the git log.

---
*Phase: 24-ooda-step-agents*
*Completed: 2026-06-26*
