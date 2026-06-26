---
phase: 24-ooda-step-agents
plan: 02
subsystem: simulation
tags: [ooda, determinism, simtask, self-rescheduling, frozen-observation, flag-bypass, tdd]

# Dependency graph
requires:
  - phase: 24-01-ooda-scaffolding
    provides: "decideTruck / deriveAgentRng / sortAgentsByStableId / AgentObservation / TrailerDiverted (the OODA leaf wired here)"
  - phase: 23-multi-center-topology
    provides: "centerOf — the agent observation's assignedCenterId"
  - phase: SP2-rest-fuel-stops
    provides: "TruckRested / TruckRefueled emit helpers the agent rest/refuel Act routes through"
provides:
  - "stepAgents SimTask (data variant) on the (fireTick,seq) queue — self-rescheduling at OODA_INTERVAL_TICKS like inductPackage (OODA-01/02)"
  - "oodaAgentsEnabled flag (STRICT === true, OFF by default; two-part flags-off gate) + lazy per-agent substream construction"
  - "frozen per-agent observation surface built at pass entry + unified sorted-by-stable-id iteration + anything-to-decide guard (OODA-04 against real engine state)"
  - "decideHub — pure hub Observe->Decide->Act (dispatch>consolidate>hold) (OODA-02)"
  - "centralized-decision bypass under the flag: departTrailer refuel + arriveTrailer consolidation owned by agents (no double-decision)"
affects: [24-03-binding-feasibility, 24-04-determinism-guard, 24-05-agent-serialization, 25-coordinators]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Self-rescheduling stepAgents SimTask mirroring inductPackage (off-guard + scheduleNext(+OODA_INTERVAL) tail), gated/seeded on the flag"
    - "Frozen observation array built ONCE at pass entry; the Decide/Act loop never re-reads fold maps (no mid-tick read-your-writes)"
    - "Unified sorted-by-stable-id total order across BOTH agent kinds (trucks + hubs); claimSeq() the same-tick tie-break"
    - "Centralized-decision bypass via if (!oodaAgentsEnabled) so the agent pass is the SOLE decider when on"

key-files:
  created:
    - packages/simulation/src/ooda/hub.ts
    - packages/simulation/src/ooda/hub.unit.test.ts
    - packages/simulation/test/ooda-engine.unit.test.ts
  modified:
    - packages/simulation/src/ooda/index.ts
    - packages/simulation/src/continuation.ts
    - packages/simulation/src/engine.ts
    - packages/simulation/test/determinism.unit.test.ts

key-decisions:
  - "OODA_INTERVAL_TICKS = 5 (Claude's discretion per ARCHITECTURE §3 '1 or 5'); OODA_START_TICK = 1; baked into the new OODA-on golden (captured in 24-04)"
  - "Unified stable-id total order across trucks + hubs (one codepoint sort over both kinds), NOT trucks-then-hubs blocks — the emit seq order is a pure function of the stable ids"
  - "anything-to-decide predicate: truck runs Act only on a binding HOS trigger (out of hours / >= 8h since break) OR fuel trigger (odometer >= refuelThreshold) OR a congested next hub (queue > 50); hub runs only when any queue/consolidation manifest is non-empty"
  - "Centralized blocks bypassed under the flag: (1) departTrailer's fuel refuel decision (odometer still ACCRUES as the agent's input, but the threshold refuel + reset is the agent's), (2) arriveTrailer's consolidation-cadence dispatch (the hub agent owns it via dispatchHubConsolidation)"
  - "Hub Decide ladder: dispatch (outbound + filled trailer + free dock) > consolidate (pending manifest) > hold (dock-busy | nothing-to-do no-op default so a tick always closes)"
  - "activeTripByTrailer is an OODA-only in-process map (no off-path effect); serializing it into the continuation is OODA-05 (24-05), not this plan"

patterns-established:
  - "Pattern: a flag-gated self-rescheduling stepAgents SimTask that constructs ZERO state on the off path (byte-identical golden) and lazily builds per-agent substreams only for agents that decide"
  - "Pattern: frozen-observation pass entry + sorted-by-stable-id Act = order-independent observation, order-fixed emit (the agent-order-shuffle witness)"
  - "Pattern: centralized decision-point bypass under an OODA flag so agents are the SOLE decider (no double-apply)"

requirements-completed: [OODA-01, OODA-02, OODA-04]

# Metrics
duration: 10min
completed: 2026-06-26
---

# Phase 24 Plan 02: Wire OODA Agents Into the Engine (stepAgents + flag + bypass) Summary

**Wired the 24-01 OODA leaf INTO the deterministic engine: a self-rescheduling `stepAgents` SimTask (cadence `OODA_INTERVAL_TICKS=5`, mirroring `inductPackage`) under a strict `oodaAgentsEnabled` flag (OFF by default), building a FROZEN per-agent observation at pass entry, iterating a UNIFIED sorted-by-stable-id agent set (trucks + hubs) with an anything-to-decide guard, running the pure `decideTruck`/new `decideHub` over each frozen surface, and Acting through the existing emit helpers + the new `TrailerDiverted` — with the engine's centralized refuel/consolidation decisions BYPASSED under the flag so agents are the sole decider. The flag-off seed-42 10k golden stays byte-identical to `3920accc…`.**

## Performance

- **Duration:** ~10 min
- **Tasks:** 3 (each committed atomically; Task 1 RED→GREEN per TDD)
- **Files modified:** 7 (3 created, 4 modified) across 3 atomic commits

## Accomplishments

- **OODA-02 hub Decide** (`ooda/hub.ts`): `decideHub(obs, rng)` is pure + deterministic with a documented ladder `dispatch > consolidate > hold`; `HubObservation` is a frozen integer/string-only snapshot (Pitfall 2); `HubDecision` is a closed `dispatch | hold | consolidate` union; the default `hold` no-op means a hub tick always closes (the P25 no-livelock foundation). Pure leaf — no engine/wall-clock import.
- **OODA-01/02 `stepAgents` SimTask** (`continuation.ts` + `engine.ts`):
  - New `{ kind: "stepAgents"; tick: number }` data variant on the `(fireTick, seq)` EventQueue — captured in `queue.snapshot()`, so it is continuation-safe by construction.
  - `oodaAgentsEnabled` flag constructed STRICT `=== true`; `stepAgents` returns immediately when off (zero passes, zero events, zero substreams). Seeded at `OODA_START_TICK=1` in the `!resuming` bootstrap (gated on the flag), self-rescheduling `+OODA_INTERVAL_TICKS` exactly like `inductPackage`. `dispatch` switch case added (the `pnpm typecheck` exhaustiveness gate proves the union is threaded).
- **OODA-04 exercised against real engine state** (the `stepAgents` body):
  - Builds a FROZEN observation array ONCE at pass ENTRY from the in-engine fold maps (`pendingBySpoke`, `pendingAtSpoke`, `odometerByTrailer`, `clockByDriver`/`driverByTrailer` via `remainingLegalDriveMinutes`/`mayDriveNow`, `centerOf`, `activeTripByTrailer`); geometry-derived miles are rounded to integers at this boundary. The Decide/Act loop NEVER re-reads the fold maps (T-24-05).
  - Iterates a UNIFIED `sortAgentsByStableId` set across trucks + hubs (one codepoint total order), so the per-pass emit `seq` order is a pure function of the stable ids (T-24-07).
  - Applies the anything-to-decide guard (skip trucks with no binding/divert trigger and no active trip; skip hubs with all-empty queues), then derives the lazy per-agent substream (`deriveAgentRng(seed, stableId)`) ONLY for an agent that decides.
  - Acts through the EXISTING emit helpers (`emitTruckRested`, `emitTruckRefueled` + odometer reset) and `emit(...)` for the new `TrailerDiverted`; the hub's consolidate/dispatch routes through `dispatchHubConsolidation` (which reuses the existing consolidation `TrailerDeparted` + `arriveConsolidationAtCenter`).
- **Centralized-decision bypass under the flag (T-24-06):** `departTrailer`'s fuel refuel decision and `arriveTrailer`'s consolidation-cadence dispatch are guarded with `!oodaAgentsEnabled` so they do NOT double-apply when agents own them. The odometer still accrues under the flag (the agent's binding-feasibility input, OODA-03), but the threshold refuel + reset is the agent's.

## Task Commits

1. **Task 1: Hub agent `decideHub` (pure Observe->Decide->Act)** — `16de40f` (feat) — RED (`hub.unit.test.ts` module-missing) → GREEN (`hub.ts` + index export); 8 tests.
2. **Task 2: `stepAgents` SimTask skeleton + `oodaAgentsEnabled` flag** — `2998826` (feat) — variant + flag + cadence constant + dispatch case + bootstrap seed; off path inert, golden byte-identical.
3. **Task 3: `stepAgents` pass body + bypass + tests** — `af1a19f` (feat) — frozen observe + sorted Act + guard + `dispatchHubConsolidation` + flag bypass; `ooda-engine.unit.test.ts` + the `oodaAgentsEnabled` two-part gate in `determinism.unit.test.ts`.

**Plan metadata:** _(this SUMMARY + STATE/ROADMAP)_ — committed separately.

## Chosen OODA_INTERVAL_TICKS + Total Order + Predicate + Bypass + Hub Ladder (the output spec)

- **`OODA_INTERVAL_TICKS` = 5** (`OODA_START_TICK` = 1) — a fixed modular constant like `PACKAGE_INTERVAL_TICKS`; per-5-tick is cheaper than every tick yet fine-grained for the demo. Baked into the new OODA-on golden (24-04).
- **Total stable-id ordering: UNIFIED** — trucks and hubs are merged into ONE `sortAgentsByStableId` set (codepoint order over both kinds), not trucks-then-hubs blocks. The emit `seq` order is therefore a pure function of the stable ids.
- **anything-to-decide predicate:**
  - Truck: an active trip exists AND (`remainingLegalDriveMinutes <= 0` OR `minutesSinceLastBreak >= 480` (HOS) OR `fuelOn && odometerMiles >= refuelThresholdMiles` OR `nextHubQueueDepth > 50` (divert)). Otherwise skipped (never a blanket sweep).
  - Hub: any of `inboundQueueDepth`, `outboundQueueDepth`, `pendingConsolidationCount` non-zero. Otherwise skipped.
- **Centralized blocks bypassed under the flag:** (1) `departTrailer`'s fuel refuel threshold-crossing + reset (odometer still accrues), (2) `arriveTrailer`'s `if (consolidationOn)` consolidation-cadence departure.
- **Hub Decide ladder:** `dispatch` (outbound queued + a filled trailer + a free dock) > `consolidate` (pending consolidation manifest non-empty) > `hold` (`dock-busy` when outbound-but-no-dock, else `nothing-to-do` — the no-op default).

## Determinism Results

- **Flag-off byte-identical:** the `oodaAgentsEnabled` two-part gate passes — `false === absent` over a 500-tick run AND `absent ⇒ 3920accc…` over the seed-42 10k golden. All prior goldens (DET-02, fuel, consolidation, continental, continuation-equivalence) stay green.
- **Flag-on reproducible:** an OODA-on 6000-tick run (`seed 42`, fuel+HOS+induction+consolidation on) hashes identically twice (same seed ⇒ byte-identical) and differs across seeds. The agent-order-shuffle batch is byte-identical (sorted iteration witness).
- **Agents own decisions:** the OODA-on stream carries **1136 `TrailerDiverted`**, **13 agent-decided `TruckRefueled`**, **84 `TruckRested`** — concrete proof the agents (not the centralized code) are deciding.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `decideHub`'s `rng` parameter tripped `@typescript-eslint/no-unused-vars`**
- **Found during:** Task 1 (`pnpm lint`)
- **Issue:** The eslint config has no `argsIgnorePattern`, so even an `_rng`-prefixed unused arg errors. The pure hub ladder is deterministic (no draw yet), but the signature must stay `(obs, rng)` for parity with `decideTruck`.
- **Fix:** Kept the named `rng` parameter and referenced it with `void rng;` plus a comment documenting the intentional no-draw (future stochastic tie-break parity).
- **Files modified:** packages/simulation/src/ooda/hub.ts
- **Committed in:** 16de40f (Task 1 commit)

### Implementation Notes (within plan scope)

- **Hub Act target:** the plan left the hub's concrete dispatch trailer to the engine. I factored `dispatchHubConsolidation(spoke)` that drains `pendingAtSpoke` onto the spoke's FIRST rostered trailer (stable, no RNG) and emits the existing consolidation events — the hub agent's binding Act for 24-02. This is the "agents own consolidate under the flag" requirement; the centralized cadence is bypassed.
- **`activeTripByTrailer`** is an OODA-only in-process map (written at `departTrailer` only when the flag is on). It is NOT yet serialized into the continuation — that is OODA-05 (24-05). 24-02's contract is single-run reproducibility (met), not chunked continuation-equivalence of the OODA-on path.

**Total deviations:** 1 auto-fixed (1 blocking lint). No scope creep; implementation matches the plan.

## TDD Compliance

Task 1 followed strict RED→GREEN (the `hub.unit.test.ts` failed module-missing first, then the `hub.ts` implementation made all 8 tests pass). Tasks 2–3 are engine-wiring tasks (`type="execute"`, no `tdd="true"`): the skeleton landed first with the flags-off golden green, then the body landed with the OODA-on integration test (`ooda-engine.unit.test.ts`) + the extended `determinism.unit.test.ts` two-part gate. Per-task commits bundle each task's tests with its code.

## Threat Mitigations Applied

- **T-24-05 (mid-tick read-your-writes):** the frozen observation array is built ONCE at pass entry; the Decide/Act loop never re-reads the fold maps. Witness: the agent-order-shuffle batch is byte-identical.
- **T-24-06 (double-applied decisions):** the centralized refuel (`departTrailer`) and consolidation (`arriveTrailer`) blocks are guarded `!oodaAgentsEnabled` so the agent pass is the sole decider when on.
- **T-24-07 (unsorted iteration):** a unified `sortAgentsByStableId` total order + the existing `(fireTick, claimSeq())` queue fix the emit order.

## Self-Check: PASSED

All 3 created files exist on disk (`ooda/hub.ts`, `ooda/hub.unit.test.ts`, `test/ooda-engine.unit.test.ts`); all 3 task commits (`16de40f`, `2998826`, `af1a19f`) are present in the git log. Final gate: 68 OODA/determinism tests pass, `pnpm typecheck` clean (exhaustiveness gate), `pnpm lint` clean, full simulation unit suite (417) + domain/projections/optimizer (547) green.

## Next Phase Readiness

- **24-03** (agent-owned binding local feasibility) can now formalize the REUSE contract: the agent refuel/rest Act already routes through the shared fuel/HOS helpers; 24-03 tightens the binding-feasibility guarantee a coordinator cannot override.
- **24-04** (determinism guard) will add the DET-03 static `no-restricted-imports` guard for the OODA packages and CAPTURE the new OODA-on golden (the `OODA_INTERVAL_TICKS=5` cadence is baked in). The flag-on run is already reproducible per seed.
- **24-05** (agent-state serialization / OODA-05) will serialize `activeTripByTrailer` into `SerializedWorldState` for chunked continuation-equivalence of the OODA-on path.
- No blockers. The flag-off seed-42 golden remains byte-identical (`3920accc…`).

---
*Phase: 24-ooda-step-agents*
*Completed: 2026-06-26*
