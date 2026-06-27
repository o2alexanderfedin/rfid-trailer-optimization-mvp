---
phase: 25-coordination-centers
plan: 01
subsystem: domain
tags: [event-sourcing, zod, closed-union, exhaustiveness, determinism, canonicalize, coordination]

# Dependency graph
requires:
  - phase: 24-ooda-step-agents
    provides: "the agent step() + feasibility verdict (the accept/reject basis), canonicalizeOodaPayload pattern, the OODA-on golden 94689f99"
  - phase: 23-topology
    provides: "centerOf / one-coordinator-per-center substrate; partitionScopeByCenter; scope-neutral PlanGenerated/Accepted/Superseded pattern in scope.ts"
provides:
  - "ActionSuggested / SuggestionAccepted / SuggestionRejected — three advisory coordination events as first-class members of the closed DomainEvent union + zod domainEventSchema"
  - "all three classified SCOPE-NEUTRAL in optimizer scope.ts (hubsOf returns []) — the anti-feedback-storm guarantee (Pitfall 11)"
  - "canonicalizeSuggestionPayload — fixed-key-order canonicalizer for the ActionSuggested hashed payload (Pitfall 7)"
  - "every exhaustive switch (contract.assert + 12 reducers + inline.affectedHubInventory + scope.hubsOf) threads the three events as no-op/audit cases"
affects: [25-02 coordinator emission, 25-03 agent handshake + COORD-03 reject surfacing, 25-04 anti-oscillation guards, 25-05 coordinator-on golden]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "closed-union member-add: schema (zod) -> type (z.infer) -> DomainEvent union -> events/index + src/index re-export -> contract.assert exhaustiveness -> every reducer + inline + scope.hubsOf"
    - "scope-neutral event classification (return [] in hubsOf) mirroring PlanGenerated/PlanAccepted/PlanSuperseded — never re-triggers the optimizer/coordinator"
    - "per-payload fixed-key-order canonicalizer for any new hashed event (coordinator/canonical.ts mirrors ooda/canonical.ts)"

key-files:
  created:
    - packages/domain/src/events/suggestion-events.test.ts
    - packages/simulation/src/coordinator/canonical.ts
    - packages/simulation/src/coordinator/canonical.unit.test.ts
  modified:
    - packages/domain/src/events/schemas.ts
    - packages/domain/src/events/domain-event.ts
    - packages/domain/src/events/index.ts
    - packages/domain/src/index.ts
    - packages/domain/src/events/contract.assert.ts
    - packages/domain/test/events.unit.test.ts
    - packages/optimizer/src/rolling/scope.ts
    - packages/projections/src/reducers/*.ts (12 reducers)
    - packages/projections/src/runner/inline.ts

key-decisions:
  - "ActionSuggested.kind closed enum = reroute|hold|consolidate|dispatch; params = a strict { toHubId?: string } (integer/string only — NO float geometry, NO RNG, Pitfall 1)"
  - "SuggestionRejected.reasonCode closed enum = hos|fuel|dock|infeasible (the reject-with-reason vocabulary for COORD-03, mirrors the Phase-24 feasibility verdict set)"
  - "issuedAtSimMs/ttlSimMs are non-negative INTEGER sim-time milliseconds from the virtual clock (the COORD-04 sim-time TTL guard substrate)"
  - "all three events SCOPE-NEUTRAL (hubsOf returns []); trailersOf left untouched (its non-exhaustive default:return [] already covers them) — confirmed by inspection, no never-guard added"
  - "single canonicalizer for ActionSuggested params this phase; SuggestionAccepted/Rejected carry only ids + enum + occurredAt (extend in Plan 03 if the reject payload needs pinning)"

patterns-established:
  - "Closed-union add proven by pnpm typecheck, NOT vitest — esbuild strips types so a missing exhaustive case passes vitest but fails tsc (the Phase-22/24 trap, demonstrated live as the RED gate here)"
  - "Grouped no-op case comments are TRAILING comments on a case label (a standalone comment line between two case labels trips ESLint no-fallthrough)"

requirements-completed: [COORD-02]

# Metrics
duration: 13min
completed: 2026-06-27
---

# Phase 25 Plan 01: Advisory Coordination Event Substrate Summary

**Three advisory coordination events (ActionSuggested / SuggestionAccepted / SuggestionRejected) added to the closed DomainEvent union + zod, threaded through every exhaustive switch, classified scope-neutral, and pinned via canonicalizeSuggestionPayload — COORD-02 substrate with ZERO behavior change (seed-42 10k golden still 3920accc).**

## Performance

- **Duration:** 13 min
- **Started:** 2026-06-26T23:50:50Z
- **Completed:** 2026-06-27T00:04:04Z
- **Tasks:** 3 (all TDD: RED -> GREEN)
- **Files modified:** 23 (3 created, 20 modified)

## Accomplishments

- **The three events are first-class closed-union members.** `ActionSuggested{suggestionId,coordinatorId,targetAgentId,kind,params,issuedAtSimMs,ttlSimMs}`, `SuggestionAccepted{suggestionId,occurredAt}`, `SuggestionRejected{suggestionId,reasonCode,occurredAt}` — added to `domainEventSchema` (zod) + the hand-written `DomainEvent` union, re-exported through both `events/index.ts` and the main `src/index.ts`, validated via `validateEvent`.
- **Every exhaustive switch threads all three.** `contract.assert.ts` (the build-gating proof), all 12 projection reducers, `inline.ts` `affectedHubInventory` (the only `default:never` switch in inline), and `scope.ts` `hubsOf` — all as no-op/audit cases. The discriminator-count test bumped 26 -> 29.
- **Scope-neutral classification (the anti-feedback-storm guarantee).** All three return `[]` in `hubsOf`, mirroring PlanGenerated/PlanAccepted/PlanSuperseded, so a suggestion/accept/reject never re-scopes the optimizer or re-triggers the suggesting coordinator (Pitfall 11). `trailersOf` left untouched (its non-exhaustive `default:return []` already covers them — confirmed by inspection).
- **canonicalizeSuggestionPayload pins the ActionSuggested key order.** A pure fixed-key-order canonicalizer (`packages/simulation/src/coordinator/canonical.ts`) mirroring `canonicalizeOodaPayload`, so the rich hashed payload never key-order-drifts the golden (Pitfall 7).
- **ZERO behavior change proven.** `pnpm typecheck` CLEAN (the real exhaustiveness gate), lint CLEAN on all touched files, the flags-off seed-42 10k golden still `3920accc…`, and the OODA-on golden `94689f99…` unchanged.

## Task Commits

Each task was committed atomically (all TDD):

1. **Task 1: Define the three suggestion events (zod + closed union + re-exports)** - `d6d805b` (feat) — 13 tests GREEN
2. **Task 2: Thread the three events through EVERY exhaustive switch + scope-neutral + discriminator count** - `e4f633c` (feat) — RED proven via `pnpm typecheck` (15 missing-case errors), then CLEAN
3. **Task 3: canonicalizeSuggestionPayload + flags-off golden re-assert** - `8024ddd` (feat) — 4 tests GREEN, golden byte-identical
4. **Lint fix (deviation):** convert standalone case comments to trailing (no-fallthrough) - `2f48772` (style)

_Note: per-task RED/GREEN were verified inline; commits are at GREEN. The discriminator-count RED-gate (Task 2) is the live demonstration of the Phase-22/24 trap (vitest green, tsc red)._

## Files Created/Modified

**Created:**
- `packages/domain/src/events/suggestion-events.test.ts` - valid-accept + malformed-reject + closed-enum coverage for all three events (13 tests)
- `packages/simulation/src/coordinator/canonical.ts` - `canonicalizeSuggestionPayload` (pure, DET-03; the new coordinator/ module)
- `packages/simulation/src/coordinator/canonical.unit.test.ts` - scrambled-insertion byte-identity + idempotent + empty-params (4 tests)

**Modified:**
- `packages/domain/src/events/schemas.ts` - 3 zod schemas + added to `domainEventSchema` discriminated union
- `packages/domain/src/events/domain-event.ts` - 3 `z.infer` types + added to `DomainEvent` union
- `packages/domain/src/events/index.ts`, `packages/domain/src/index.ts` - re-export types + schemas (both indexes)
- `packages/domain/src/events/contract.assert.ts` - 3 exhaustiveness cases before `assertNever`
- `packages/domain/test/events.unit.test.ts` - describeEvent cases + DomainEventType count 26 -> 29
- `packages/optimizer/src/rolling/scope.ts` - 3 scope-neutral cases in `hubsOf` (Pitfall-11 comment)
- `packages/projections/src/reducers/{audit-timeline,delivery-kpi,driver-assignment,driver-status,exceptions,geo-track,hub-inventory,package-location,tag-registry,trailer-fuel,trailer-state,zone-estimate}.ts` - 3 no-op cases each
- `packages/projections/src/runner/inline.ts` - 3 no-op cases in `affectedHubInventory`

## COORD-02 Threading List (the closed-union audit)

- [x] zod `domainEventSchema` discriminated union (schemas.ts)
- [x] `DomainEvent` hand-written union (domain-event.ts)
- [x] type re-export: `events/index.ts` AND `src/index.ts` (the trailer-diverted lesson)
- [x] schema re-export: `events/index.ts` AND `src/index.ts`
- [x] `contract.assert.ts` exhaustiveness proof (the BUILD gate)
- [x] discriminator-count test 26 -> 29 + describeEvent (events.unit.test.ts)
- [x] `scope.ts` `hubsOf` — SCOPE-NEUTRAL (return []); `trailersOf` confirmed covered by its default
- [x] all 12 projection reducers (no-op/audit cases)
- [x] `inline.ts` `affectedHubInventory` (the one `default:never` helper)
- [x] `canonicalizeSuggestionPayload` (coordinator/canonical.ts)

## Byte-Identical Confirmation

- Flags-off seed-42 10k golden: **`3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861`** — unchanged (this plan adds only no-op switch cases + a pure helper; no engine emission — coordinator wiring is Plan 02).
- OODA-on golden: **`94689f9989c0019edff27134dad0ef4cfb07c15c9c308ef4b40c38e848f4e608`** — unchanged.
- `pnpm typecheck` CLEAN (every exhaustive switch names the three members — the primary proof for this plan).

## Decisions Made

See `key-decisions` frontmatter. Highlights: closed `kind` enum (reroute|hold|consolidate|dispatch) + closed `reasonCode` enum (hos|fuel|dock|infeasible); integer/string-only `params` (`{ toHubId?: string }`, strict) and integer sim-time ms (Pitfall 1, no RNG/float); all three scope-neutral; `trailersOf` deliberately left without a never-guard (its existing non-exhaustive default already covers them — no over-engineering).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] ESLint `no-fallthrough` on standalone case comments**
- **Found during:** Overall verification (lint gate), after Task 2/3 edits
- **Issue:** A standalone comment line placed BETWEEN two `case` labels (e.g. `// Phase-25 …` on its own line before `case "ActionSuggested":`) trips ESLint's `no-fallthrough` rule (15 errors across the 12 reducers + inline.ts + contract.assert.ts + scope.ts). Pre-existing repo convention uses TRAILING comments on case labels for grouped no-op cases.
- **Fix:** Converted each standalone Phase-25 comment to a trailing comment on the `case "ActionSuggested":` label; in `scope.ts` moved the longer Pitfall-11 explanation into the case body (no fallthrough trigger). Behavior unchanged (comment-only edit).
- **Files modified:** contract.assert.ts, scope.ts, all 12 reducers, inline.ts
- **Verification:** `pnpm typecheck` CLEAN, ESLint exit 0 on all touched files, all 28 new/updated tests + both goldens re-run GREEN
- **Committed in:** `2f48772` (style)

---

**Total deviations:** 1 auto-fixed (1 blocking lint). 
**Impact on plan:** Comment-only; no logic/behavior change. No scope creep. All goldens byte-identical before and after.

## Issues Encountered

None beyond the lint deviation above. The Task 2 RED gate behaved exactly as the plan predicted — `pnpm typecheck` surfaced all 15 missing exhaustive cases while vitest stayed green (the esbuild-strips-types trap), confirming typecheck (not vitest) is the exhaustiveness proof.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The event substrate (COORD-02) is in place: Plan 02 can emit `ActionSuggested` from the in-fold `stepCoordinators` task (routing the payload through `canonicalizeSuggestionPayload`); Plan 03 can consume it in the Phase-24 agent step (accept -> binding event + `SuggestionAccepted`; reject -> `SuggestionRejected` + COORD-03 alert-feed surfacing — the reducer no-op cases are the wiring points); Plan 05 captures the coordinator-on golden.
- No blockers. The three events are scope-neutral, canonicalized, and inert until a coordinator is wired (flag `coordinatorsEnabled` OFF by default, added in Plan 02).

## Self-Check: PASSED

- Created files verified on disk: suggestion-events.test.ts, coordinator/canonical.ts, coordinator/canonical.unit.test.ts, 25-01-SUMMARY.md
- Task commits verified in git log: d6d805b, e4f633c, 8024ddd, 2f48772
- Gates: `pnpm typecheck` CLEAN, ESLint CLEAN on all touched files, 28 new/updated tests GREEN, flags-off golden 3920accc + OODA-on golden 94689f99 byte-identical

---
*Phase: 25-coordination-centers*
*Completed: 2026-06-27*
