---
phase: 24-ooda-step-agents
plan: 04
subsystem: simulation
tags: [ooda, determinism, continuation-equivalence, golden, eslint-guard, canonicalize, det-03]

# Dependency graph
requires:
  - phase: 24-01-ooda-scaffolding
    provides: "deriveAgentRng (stateless re-derive) / sortAgentsByStableId / decideTruck / OODA_RNG_SALT / TrailerDiverted — the determinism primitives these goldens witness"
  - phase: 24-02-ooda-engine-wiring
    provides: "stepAgents SimTask + oodaAgentsEnabled flag + activeTripByTrailer in-process map (serialized here) + the two-part flags-off gate (re-asserted)"
  - phase: 24-03-binding-feasibility
    provides: "the pure feasibility leaf the DET-03 ESLint guard now statically protects"
  - phase: 19-08-resumable-core
    provides: "SerializedWorldState / runToHorizon continuation core the agent state extends + the continuation-equivalence harness pattern"
provides:
  - "activeTripByTrailer serialized into SerializedWorldState (OODA-05 continuation-equivalence; chunked OODA-on run byte-identical to all-at-once)"
  - "OODA-on 10k golden 94689f99… captured reproducibility-first + committed (!= flags-off 3920accc)"
  - "agent-order-shuffle + N-agent decorrelation + salt-collision first-class committed goldens (OODA-04)"
  - "DET-03 ESLint static guard scoped to ooda/** banning Date.now/Math.random/new Date()/async-queue/kysely (fails CI on a violation)"
  - "canonicalizeOodaPayload — every hashed OODA payload routed through a fixed-key-order canonicalizer (Pitfall 7)"
affects: [25-coordinators, 28-continental-hardening]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Present-only-when-on agent-state serialization in SerializedWorldState (fixed key order, tuple array) — off path byte-identical"
    - "Stateless per-agent RNG re-derive ⇒ NO new SerializedRngStates field (the simpler, byte-safe choice documented in the plan read_first)"
    - "Reproducibility-first golden capture: prove same-seed in-process AND across-process identity BEFORE baking the literal (never commit a flaky golden)"
    - "DET-03 ESLint no-restricted-imports/no-restricted-syntax static guard scoped to the decision core, proven by a planted-violation check"
    - "Canonicalize every hashed payload at one fixed-key-order site (mirror canonicalHosClock)"

key-files:
  created:
    - packages/simulation/test/ooda-continuation.unit.test.ts
    - packages/simulation/test/ooda-determinism.unit.test.ts
    - packages/simulation/src/ooda/canonical.ts
    - .planning/phases/24-ooda-step-agents/deferred-items.md
  modified:
    - packages/simulation/src/continuation.ts
    - packages/simulation/src/engine.ts
    - packages/simulation/src/ooda/index.ts
    - eslint.config.ts

key-decisions:
  - "Agents carry ONE new cross-tick state: activeTripByTrailer (set at departTrailer when on, never deleted). Serialized into SerializedWorldState as a fixed-key-order [trailerId,{tripId,fromHubId,toHubId}] tuple array; empty on the off path"
  - "Per-agent RNG is a STATELESS re-derive (deriveAgentRng rebuilt each pass from seed+id, no stored position) ⇒ NO new SerializedRngStates.ooda field; off path trivially clean"
  - "OODA_ON_GOLDEN_SHA256 = 94689f9989c0019edff27134dad0ef4cfb07c15c9c308ef4b40c38e848f4e608 (seed 42 / 10k / oodaAgentsEnabled+hos+fuel+induction+consolidation, OODA_INTERVAL_TICKS=5; 9170 events; x86_64 darwin)"
  - "ESLint guard selectors: CallExpression Date.now / Math.random; NewExpression Date arguments.length=0; no-restricted-imports kysely + @alexanderfedin/async-queue (+ *async-queue* / db patterns), scoped to ooda/**/*.ts excluding *.test.ts"
  - "Canonicalization: ooda/canonical.ts canonicalizeOodaPayload pins the TrailerDiverted payload key order (the only genuinely-new OODA hashed payload); the event stream's JSON.stringify is the canonical hashed surface, so no scopeHash-like helper is needed beyond this"
  - "Two-part flags-off gate for oodaAgentsEnabled was already landed in 24-02 (determinism.unit.test.ts:294-330); re-asserted green here, not duplicated"

requirements-completed: [OODA-04, OODA-05, DET-03]

# Metrics
duration: 15min
completed: 2026-06-26
---

# Phase 24 Plan 04: OODA Determinism Keystone — Continuation-Equivalence + Goldens + DET-03 Guard Summary

**Closed the determinism + continuation contract for the OODA agents: serialized the one new cross-tick agent datum (`activeTripByTrailer`) into `SerializedWorldState` so a chunked/continued OODA-on run is byte-identical to all-at-once (OODA-05); captured the agent-order-shuffle, N-agent-decorrelation, salt-collision, and a NEW reproducibility-first OODA-on 10k golden (`94689f99…`, != flags-off `3920accc…`) as first-class committed tests (OODA-04); landed the DET-03 ESLint static guard scoped to `ooda/**` that FAILS CI on `Date.now`/`Math.random`/`new Date()`/`async-queue`/`kysely` (proven by a planted-violation check) and routed the `TrailerDiverted` payload through a fixed-key-order `canonicalizeOodaPayload`. Fixed a latent continuation bug along the way (roster seeding clobbered the restored odometer on resume). Full phase gate green: build 10/10, typecheck clean, lint clean (guard active), 210 OODA/determinism + 457 simulation-unit + 547 domain/proj/opt tests pass.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-06-26T22:55:09Z
- **Completed:** 2026-06-26T23:10:14Z
- **Tasks:** 3 (each committed atomically)
- **Files modified:** 8 (4 created, 4 modified) across 3 atomic commits

## Do agents carry new cross-tick state? (the output spec question)

**Yes — exactly ONE datum: `activeTripByTrailer`** (trailerId → `{tripId, fromHubId, toHubId}`),
written at `departTrailer` ONLY when `oodaAgentsEnabled`, never deleted (overwritten on the
next departure). Everything else the `stepAgents` Observe reads (`pendingBySpoke`,
`pendingAtSpoke`, `odometerByTrailer`, `driverByTrailer`, `clockByDriver`) was already
serialized by the existing continuation. It now serializes as a present-only-when-on,
fixed-key-order `[trailerId, {tripId, fromHubId, toHubId}]` tuple array (mirroring
`pendingBySpoke`), captured in `captureContinuation` and restored in the bootstrap.

**The per-agent RNG is a STATELESS re-derive** — `deriveAgentRng(seed, id)` rebuilds a fresh
`Rng` each pass from `seed` + the stable id with NO stored stream position (24-01 design,
ARCHITECTURE §3). So there is **NO** new `SerializedRngStates.ooda` field, and the off path is
trivially clean (the simpler, byte-safe choice the plan's `read_first` flagged).

## OODA-on golden (reproducibility-first)

- **`OODA_ON_GOLDEN_SHA256 = 94689f9989c0019edff27134dad0ef4cfb07c15c9c308ef4b40c38e848f4e608`**
- **Config:** `simulate({ seed: 42, durationTicks: 10000, oodaAgentsEnabled: true, hosEnabled: true, fuel: {…1200mi}, inductionEnabled: true, consolidationEnabled: true })`; `OODA_INTERVAL_TICKS=5` baked in.
- **Capture environment:** x86_64 (darwin), **9170 events**.
- **Reproducibility-first:** before baking the literal I ran it twice in-process (identical) AND across two separate test-process invocations (identical), per PITFALLS "never commit a non-reproducible golden." The committed test re-asserts in-process reproducibility on every run.
- **`!= 3920accc…`:** asserted distinct from the flags-off golden (the OODA model genuinely changed the decisions).

## DET-03 ESLint guard (proven to fire)

A flat-config block scoped to `files: ["packages/simulation/src/ooda/**/*.ts"]`,
`ignores: ["…/*.test.ts"]`:
- `no-restricted-syntax`: `Date.now()` (`CallExpression[callee.object.name='Date'][callee.property.name='now']`), `Math.random()` (`…Math…random`), wall-clock `new Date()` (`NewExpression[callee.name='Date'][arguments.length=0]`).
- `no-restricted-imports`: `kysely` (+ `kysely/*`, `pg`, `*/persistence` patterns) and `@alexanderfedin/async-queue` (path + `*async-queue*` pattern).

**Proof it fires:** planted `Date.now()` + `Math.random()` + `new Date()` in a throwaway
`ooda/__guard_probe.ts` and `kysely` + `@alexanderfedin/async-queue` imports in
`ooda/__guard_probe2.ts` — every one errored with its DET-03 message; both probes removed; the
clean tree + full `pnpm lint` pass (exit 0).

## Canonicalization decision

The OODA agents introduce ONE genuinely-new hashed payload with no centralized analog —
`TrailerDiverted`. `packages/simulation/src/ooda/canonical.ts` exports
`canonicalizeOodaPayload` (fixed key order `trailerId, tripId, fromHubId, toHubId, reason,
occurredAt`, values untouched — mirrors `canonicalHosClock`), and the divert emit site routes
its payload through it. The literal was already built in schema order, so this is
byte-identical to before (the flags-off `3920accc…` golden is unchanged) — it pins the order
against future refactors (Pitfall 7). No other OODA payload is hashed beyond the event stream
itself, whose `JSON.stringify` ordering is the canonical hashed surface.

## Continuation-equivalence (OODA-05) results

`test/ooda-continuation.unit.test.ts` (7 tests, all green): an OODA-on run driven in CHUNKS via
`runToHorizon` is byte-identical (SHA-256 over the ordered stream) to all-at-once at chunk
sizes 1 (every-tick boundary, h 600), 7, 23, and 500 (h 2000); the captured continuation
carries `activeTripByTrailer` as plain JSON-round-trippable data; resuming from the JSON-revived
continuation matches the in-memory one; and with OODA off the captured `activeTripByTrailer` is
`[]` (off path byte-identical).

## Determinism goldens (OODA-04) results

`test/ooda-determinism.unit.test.ts` (11 tests, all green):
- **agent-order-shuffle:** shuffling the per-pass agent INPUT order (reverse, hand-permute,
  rotate) yields a byte-identical sorted Decide batch; the batch order is the codepoint-sorted
  stable-id order, input-independent.
- **N-agent decorrelation:** N=75 real agent ids (`T001..T064` + the 11 USA hub ids) have
  pairwise-distinct first-K(8) draw sequences AND distinct first draws; rename/reorder leaves
  each agent's stream unchanged (keyed on the stable id, never array position).
- **salt-collision:** `OODA_RNG_SALT` pairwise-distinct from the 8 exported engine salts.
- **OODA-on golden:** the `94689f99…` hash + in-process reproducibility + `!= 3920accc…` +
  validateEvent boundary + `TrailerDiverted` present.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Roster seeding clobbered the restored odometer on resume**
- **Found during:** Task 1 (the new OODA continuation-equivalence test FAILED — chunked diverged from all-at-once; a `TruckRefueled` was lost just after a chunk boundary).
- **Issue:** `engine.ts:963` ran `if (fuelOn) odometerByTrailer.set(`T${id}`, 0)` UNCONDITIONALLY during roster seeding — including on a RESUME, overwriting the values just restored from `start.world.odometerByTrailer` back to 0. A latent continuation gap: the centralized fuel path never made the lost miles observable, but the OODA-on refuel decision READS the accrued odometer, so a chunk boundary lost the accrued miles and the agent never crossed the refuel threshold. Field-by-field continuation diff at tick 500 isolated it: every field EQUAL except `odometerByTrailer` (all zeros in the chunked run).
- **Fix:** guard with `&& !resuming` so the seeding only runs on a fresh start and the restored odometer survives.
- **Files modified:** packages/simulation/src/engine.ts
- **Verification:** the continuation diff shows `odometerByTrailer: EQUAL` post-fix; the OODA continuation-equivalence test (7) + the EXISTING fuel-determinism + continuation-equivalence suites (95) all pass — no regression, and the flags-off `3920accc…` golden is unchanged.
- **Committed in:** 417c854 (Task 1 commit)

**Total deviations:** 1 auto-fixed (1 bug). It also hardens the pre-existing non-OODA fuel continuation path. No scope creep.

## Out-of-Scope Discoveries (deferred, NOT fixed)

Two PRE-EXISTING API WebSocket unit failures surfaced in the full gate — verified identical on
the plan base commit `6a73ddd` (before any 24-04 commit), in files this plan never touched
(`packages/simulation/**` + `eslint.config.ts` only):
- `packages/api/test/ws-delivery.unit.test.ts` — WS delivery wiring (VIZ-14)
- `packages/api/test/ws-induction.unit.test.ts` — WS induction wiring (VIZ-13)

Both share a WS-mock harness defect (`socket.close is not a function` ⇒ empty snapshot count).
Logged to `.planning/phases/24-ooda-step-agents/deferred-items.md` per the SCOPE BOUNDARY rule;
suggested owner: Phase 27 viz/plumbing hardening.

## Full Phase Gate (all green)

| Gate | Result |
|------|--------|
| `pnpm build` (turbo) | **10/10 tasks successful** |
| `pnpm typecheck` (`tsc --noEmit`) | **clean (exit 0)** |
| `pnpm lint` (eslint ., DET-03 guard active) | **clean (exit 0)** |
| OODA + determinism lane (12 files) | **210 passed** |
| Simulation unit suite (37 files) | **457 passed** |
| Domain + projections + optimizer unit (51 files) | **547 passed** |
| API + web unit (42 files) | 474 passed; **2 PRE-EXISTING failures** (deferred, out of scope — see above) |

Gates were run ONE LANE AT A TIME with `pkill -f vitest` between runs (heeding the v2-gate-OOM
memory — the full concurrent gate OOMs/exit-137).

## TDD Compliance

Task 2 is `type: tdd`. The OODA-on golden was captured RED-first (a throwaway capture test
proved same-seed reproducibility in-process and across processes BEFORE the literal was baked),
then the committed determinism golden test asserts it GREEN. The order-shuffle / decorrelation /
salt-collision goldens are property assertions that consolidate the partial 24-01/24-02 checks.
Tasks 1 and 3 are `type: execute`: Task 1's continuation-equivalence test was written first, ran
RED (chunked diverged), exposing the odometer bug, then GREEN after the fix; Task 3's guard was
proven RED via planted violations, then the clean tree passes GREEN. Per-task commits bundle each
task's tests with its code.

## Threat Mitigations Applied

- **T-24-11 (Date.now/Math.random/async-queue in the core):** the DET-03 ESLint guard fails the
  lint on a violation — proven by the planted-violation probe.
- **T-24-12 (unserialized agent state across a continuation boundary):** `activeTripByTrailer`
  captured/restored; the per-agent RNG is a stateless re-derive (nothing to serialize); the
  chunked==all-at-once OODA continuation-equivalence test is the witness. The odometer-clobber
  fix removed the remaining boundary divergence.
- **T-24-13 (OODA-on model with no committed golden):** `OODA_ON_GOLDEN_SHA256 = 94689f99…`
  captured reproducibility-first, asserted in-process-reproducible and `!= 3920accc…`.
- **T-24-14 (a flags-off regression shifting the seed-42 golden):** the two-part flags-off gate
  (`:false === absent` AND `absent ⇒ 3920accc…` over short + 10k) stays green.

## Next Phase Readiness

- The OODA agent layer now replays byte-identically end-to-end: flags-off `3920accc…` is
  preserved, the OODA-on `94689f99…` golden is committed + reproducible, and a chunked/continued
  OODA-on run is byte-identical to all-at-once. The DET-03 static guard protects the decision
  core going forward.
- **Phase 25 (coordinators)** can arbitrate against the established binding-feasibility contract
  with confidence that the agent substrate is fully deterministic; any new coordinator hashed
  payload must route through a canonicalizer (the `ooda/canonical.ts` pattern) and stay clear of
  the DET-03-banned imports/syntax.
- **Phase 28 (consolidated determinism audit)** inherits the two committed goldens + the static
  guard as the audit baseline.
- No blockers. (Deferred: 2 pre-existing API WS-mock test failures — Phase 27.)

## Self-Check: PASSED

All 4 created files exist on disk; all 3 task commits (`417c854`, `689a06e`, `c62db01`) are
present in the git log.

---
*Phase: 24-ooda-step-agents*
*Completed: 2026-06-26*
