# Architecture Research — v3.0 Continental OODA Network (Integration)

**Domain:** Event-sourced, deterministic discrete-event logistics simulation
**Researched:** 2026-06-26
**Confidence:** HIGH (codebase grounded; every integration point names a real file/module)
**Scope:** ONLY how v3.0 features layer onto the SHIPPED architecture without breaking the
event-sourced, seeded, byte-identical-golden-replay core.

> This file SUPERSEDES the prior (v2.0) `ARCHITECTURE.md` for the v3.0 milestone. The v2.0
> doc's baseline survey remains accurate; this one is the milestone-scoped integration design the
> roadmap author consumes.

---

## 0. The invariants v3.0 must not break (read first)

These are load-bearing facts verified in the codebase. Every v3.0 design choice below is judged
against them.

| Invariant | Where it lives | Why it constrains v3.0 |
|-----------|----------------|------------------------|
| **One generation core** `runToHorizon` drives ALL streams (`simulate`/`runSimulation` both call it) | `packages/simulation/src/engine.ts:512` | New behavior must enter the SAME core, never a parallel path, or the in-memory and persisted streams diverge. |
| **EventQueue total order** is `(fireTick, insertionSeq)` — a stable sort, ties broken by monotonic `claimSeq()` | `engine.ts:433` (`EventQueue`), `engine.ts:2042` (drain loop) | Agent steps must be scheduled as queue tasks with deterministic `fireTick`+`seq`, never iterated from a Map/Set. |
| **DATA tasks, never closures** — the queue holds a `SimTask` discriminated union; one `dispatch()` switch reconstructs behavior | `continuation.ts:27` (`SimTask`), `engine.ts:1965` (`dispatch`) | Every new agent/coordinator action MUST add a `SimTask` variant (so it serializes into the continuation). |
| **Seeded substream-per-feature** — `seed XOR salt`, each salt asserted pairwise-distinct; the substream is constructed ONLY when its feature is on | `engine.ts:78–127` (8 salts), `rng.ts` (`makeRng`/`makeRngFromState`) | New stochastic agent decisions get NEW salts; an off feature must construct NO generator and draw ZERO values. |
| **Closed event union** in `@mm/domain` (zod-inferred, exhaustive switch, build fails on drift) | `domain-event.ts:178` (`DomainEvent`), `events/contract.assert.ts` | New event types (`ActionSuggested`, …) must be added to the union AND a zod schema AND every exhaustive switch (`scope.ts`, inline appliers). |
| **Pure reducers; live == rebuilt** — `applyInline` is the single fold path for live + rebuild | `projections/src/runner/inline.ts:697` | A coordinator that maintains state must derive it by folding logged events (a projection or an in-engine fold), never from ambient state. |
| **No wall-clock / no unseeded random** anywhere in the sim core or optimizer epoch | `engine.ts` (VirtualClock only), `optimizer/.../rolling/types.ts:26`, `optimizer/.../rolling/scope.ts:13` | Coordinators + OODA steps read time from the virtual clock / event time only. |
| **Single center** `USA_HUBS[0]` (Memphis) is hard-wired in 4 places | `routes.ts:157,289` (`buildTransitParamsByLeg`,`buildRoutes`); `engine.ts:710` (`const center = hubs[0]`); `twin-snapshot.ts:555` (`deriveCenterHub`) | Multi-center generalization touches exactly these four sites + the consolidation re-sort logic. |
| **Determinism keystone** golden `3920accc…` = `simulate({seed:42,durationTicks:10000})`; flags-off must stay byte-identical | `simulation/test/determinism.unit.test.ts:126` | Every v3.0 feature is flag-gated; the OODA/coord model is a NEW model with NEW goldens. |
| **async-queue is Promise/microtask** (`vendor/async-queue`) — backpressure, O(1) circular buffer | `vendor/async-queue/src/index.ts:24` | MUST stay out of the deterministic core (microtask ordering ≠ deterministic event order). Runtime plumbing only. |

---

## 1. System overview — where v3.0 plugs in

```
┌───────────────────────── DETERMINISTIC CORE (byte-identical replay) ──────────────────────────┐
│                                                                                                │
│  packages/simulation/src/engine.ts  ──  runToHorizon  (the SINGLE generation core)             │
│   ┌───────────────────────────────────────────────────────────────────────────────────────┐  │
│   │  EventQueue (fireTick, seq)  →  dispatch(SimTask)  →  emit(streamId, DomainEvent)        │  │
│   │     ▲                                  │                                                 │  │
│   │     │ schedule()                       ▼                                                 │  │
│   │  ┌──────────── NEW v3.0 (flag-gated) ──────────────────────────────────────────────────┐│  │
│   │  │  stepAgents(tick)       OODA Observe→Orient→Decide→Act · per-agent seeded substream   ││  │
│   │  │  stepCoordinators(tick) per-center process managers · fold events → ActionSuggested   ││  │
│   │  └──────────────────────────────────────────────────────────────────────────────────────┘│  │
│   └───────────────────────────────────────────────────────────────────────────────────────┘  │
│   network/hubs.ts (big-city gen)  ·  network/routes.ts (multi-center buildRoutes + greatCircle)│
│                                                                                                │
└───────────────────────────────────────────┬────────────────────────────────────────────────────┘
                                             │  SimulatedEvent[] (ordered)
                                             ▼
┌─────────────── RUNTIME PLUMBING (wall-clock; async-queue lives HERE, NOT above) ───────────────┐
│  api/src/sim/driver.ts  driveSimulationPaced / OpenEnded                                       │
│    append (OCC) → applyInline fold (projections/inline.ts) → runDetection → coalescer(opt)     │
│    → ws broadcast                                                                              │
│                                          │ worker_threads                                      │
│                                          ▼                                                     │
│  api/src/optimizer: worker-client → optimizer-worker → RollingOptimizerService.runOnce →       │
│    runEpoch  ·  twin-snapshot.ts (full log scans — INCREMENTAL FOLD debt, §8)                  │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**The one-sentence v3.0 thesis:** add three flag-gated behaviors INSIDE `runToHorizon`
(multi-center topology, OODA `step()` agents, per-center coordinator process-managers) that emit
NEW `DomainEvent` types into the SAME log, leave the optimizer as a *suggestion engine* invoked by
coordinators, and keep `async-queue` purely in the wall-clock plumbing layer below the core.

---

## 2. Multi-center generalization (build FIRST — everything else assumes it)

### What changes vs stays

| Component | File | Change |
|-----------|------|--------|
| Hub dataset | `network/hubs.ts:14` `USA_HUBS` | **MODIFY** → add `generateBigCityHubs()`: a curated static `[name,state,lat,lon,rank]` table → top 1–3 metros/state (~80–130 hubs). PURE, no clock/RNG. Add `role: "center" \| "spoke"` (or derive it). Flag `continentalTopology` selects this vs the 10 fixed hubs. |
| Center selection | NEW `network/centers.ts` | **NEW** → `pickRegionalCenters(hubs)`: deterministic partition (region/timezone band by longitude, or k largest-by-rank per band) → a small set of center hubs. Pure. |
| Nearest assignment | NEW in `network/routes.ts` | **NEW** → `assignSpokesToNearestCenter(spokes, centers)`: each spoke → `argmin haversineKm` center (tie-break by sorted center id — anti-P3). Reuses existing `haversineKm` (re-exported from `@mm/domain`). |
| Route builder | `routes.ts:283` `buildRoutes` | **MODIFY** → from "every spoke ↔ `hubs[0]`" to: (a) spoke↔assignedCenter legs, (b) center↔center **backbone** legs. Keep the directed-pair + stable input order. Geometry = `greatCircle` (already present, `routes.ts:51`); skip per-leg ORS — `applyRoadGeometry` already falls back to great-circle when the file is absent (the default). |
| Transit params | `routes.ts:141` `buildTransitParamsByLeg` | **MODIFY** → same spoke↔center + backbone leg set, same per-leg haversine median. The `const center = hubs[0]` at `routes.ts:157` becomes a loop over (spoke→its center) + (center→center). |
| Engine freight flow | `engine.ts:710` `const center = hubs[0]` + the consolidation/distribution tasks | **MODIFY** → replace the single `center`/`spokes` split with a `centerOf(spokeHubId)` map. `departTrailer`/`arriveTrailer`/`arriveConsolidationAtCenter` route **spoke→nearest-center→backbone→dest-center→dest-spoke**. The relevant `SimTask` variants gain a `centerHubId` field (additive). |
| Twin center | `twin-snapshot.ts:555` `deriveCenterHub` | **MODIFY** → return the SET of centers (or per-trailer center). `TwinSnapshot.centerHubId?` (`rolling/types.ts:153`) becomes `centerHubIds?: readonly string[]` (additive; absent ⇒ `hubs[0]` back-compat). |
| Optimizer scope | `rolling/scope.ts:121` `detectAffectedScope` | **MODIFY** → it already collects referenced hubs/trailers from events; with backbone legs it naturally scopes to the touched centers. Add **per-center scoping**: partition the affected hub set by center so one center's epoch never pulls another center's trailers (bounded fan-out — the whole point). |

### Determinism guidance (multi-center)
- Hub generation + center selection + nearest-assignment are **pure functions of the static dataset**
  — no clock, no RNG. They produce a byte-stable topology, so the `RouteRegistered` bootstrap
  (`engine.ts:1001`) is reproducible. This is exactly how `USA_HUBS` is reproducible today.
- The **freight-flow path** (which center a spoke routes through) must be a deterministic map built
  once at bootstrap. Keep `centerOf` a pure lookup, not a per-tick recompute. If topology is static
  (preferred), it need not even be captured in the continuation — it re-derives identically.
- **Flag gate:** `continentalTopology` off ⇒ `buildRoutes(USA_HUBS)` unchanged ⇒ golden `3920accc…`
  holds. On ⇒ NEW model, NEW golden (a small fixed seed + small hub count for a fast hash).
- **Per-center scoping is the scaling fix**, not merely an optimization: it caps each epoch's twin to
  one center's trailers/hubs, which is what removes the "global solve over growing state" stall the
  design notes call out.

### Build-order note
Multi-center is the foundation: OODA agents read the topology (which center am I heading to?), and
coordinators are *one per center*. Ship topology + new golden BEFORE agents.

---

## 3. OODA `step()` inside the deterministic engine

### Pattern: agents are scheduled queue tasks, not a parallel loop

The design notes already reject "a full ABM rewrite of the event queue." The determinism-safe
insertion is a **per-tick (or per-N-tick) self-rescheduling `SimTask`** that runs every agent's
`step()` in a **fixed, sorted order** — exactly like the existing `createPackageBatch` /
`inductPackage` self-rescheduling tasks (`engine.ts:1110,1252`, scheduled at `engine.ts:2013,2026`).

```
SimTask  (continuation.ts:27)  +=
  | { kind: "stepAgents";       tick: number }   // OODA pass
  | { kind: "stepCoordinators"; tick: number }   // process-manager pass (§4)
```

**Insertion point:** add two cases to the `dispatch` switch (`engine.ts:1965`) and seed them at
bootstrap (`engine.ts:2012`, the `!resuming` block), each self-rescheduling `+OODA_INTERVAL_TICKS`.
They fire on the same `(fireTick, seq)` queue as everything else, so ordering stays total and stable.

### The four phases, mapped to determinism-safe operations

| OODA phase | Operation | Determinism rule |
|-----------|-----------|------------------|
| **Observe** | Read the agent's local state + a read-only view of the world AS OF the current tick | MUST read state folded from events with `occurredAt ≤ now`, never future queue tasks. In-engine, read the lightweight per-agent world maps (already the pattern: `pendingBySpoke`, `odometerByTrailer`, `driverByTrailer`, `clockByDriver`). Do NOT read the Postgres projections from inside the core (that's the async plumbing layer). |
| **Orient** | Pure assessment over observed state | Pure function. No RNG unless seeded (below). |
| **Decide** | Pure (optionally seeded) choice | If stochastic, draw from a **per-agent seeded substream**: `makeRng((seed ^ OODA_SALT ^ hash(agentId)) >>> 0)`. The repo ALREADY salts substreams (`engine.ts:86–127`); extend the discipline with an agent-id mix so two agents deciding in the same tick never share a stream. Construct the generator ONLY when the OODA flag is on. |
| **Act** | `emit(streamId, event)` of a domain event | The emit is the ONLY side effect; route it through the existing `emit` (`engine.ts:809`) so it lands in the ordered stream + bumps `nextSequenceId`. |

### Agent step ordering (the critical determinism choice)
Within one `stepAgents` tick, iterate agents in a **stable sorted id order** (e.g. trailer ids
`T001…`, then hub ids sorted). Never iterate a `Map`/`Set` insertion order. Each agent's seeded draw
is independent (per-agent substream), so the *order* of stepping does not change any single agent's
draws — but it DOES fix the order of emitted events (the `seq` tie-break), so a sorted order is
mandatory for byte-identical output. This mirrors the existing `trailerRoster` stable ordering
(`engine.ts:760`).

### Read-projections mid-tick vs end-of-tick
- **Observe reads end-of-PREVIOUS-tick state** (state folded from all events with `occurredAt < now`),
  which is automatic because agents read the in-engine fold maps that prior dispatches already mutated.
  This avoids intra-tick read-write hazards.
- If two agents in the same `stepAgents` pass could observe each other's same-tick emissions,
  **forbid it.** Simplest deterministic rule: **Observe is a pure read of the fold maps as they stand
  at pass entry; Act appends to the queue/stream; the fold maps are NOT re-read within the pass.**
  This makes the pass order-independent w.r.t. observation, and order-dependent only w.r.t. emitted
  `seq` (which the sorted iteration fixes).

### Cadence
Per-N-tick (`OODA_INTERVAL_TICKS`, e.g. 1 or 5) is fine and cheaper. It's a fixed modular constant
(like `PACKAGE_INTERVAL_TICKS = 15`, `engine.ts:343`) — pure tick arithmetic, no wall-clock. The
cadence is part of the model, so it's baked into the new golden.

### Continuation safety
`stepAgents`/`stepCoordinators` are `SimTask` variants ⇒ captured in `queue.snapshot()`
(`engine.ts:479`). Any per-agent mutable state (e.g. an agent's local memory) must be added to
`SerializedWorldState` (`continuation.ts:103`) and restored on resume, exactly as `pendingBySpoke`
et al. are. The continuation-equivalence test (chunked == all-at-once) is the witness.

---

## 4. Coordination center = event-sourcing PROCESS MANAGER

### Definitional grounding
A **process manager** (vs a stateless saga) is a *state machine* that decides based on the incoming
event AND its own accumulated state, reacting to events and emitting new commands/events
([Event-Driven.io](https://event-driven.io/en/saga_process_manager_distributed_transactions/),
[DevArchive](https://blog.devarchive.net/2015/11/saga-vs-process-manager.html)). That is exactly the
coordinator: it subscribes to truck/hub events, maintains localized state, and emits advisory
suggestions. The advisory-then-accept handshake is **choreography** (agents react), not orchestration.

### Run it as a deterministic in-engine step-agent (NOT as an async plumbing subscriber)

A process manager could live in two places:
1. **Inside the deterministic fold** (a `stepCoordinators` `SimTask`, alongside OODA). ← **CHOOSE THIS.**
2. As a separate async subscriber in `api/src/` reacting to the live stream. ← **REJECT** for the
   suggestion-generating coordinator — it would read wall-clock-ordered, async-delivered events and
   could not be replayed byte-identically.

**Why in-fold:** the coordinator *changes the event stream* (it emits `ActionSuggested`, which
triggers agent accept/reject, which emits binding events). Anything that changes the stream must be
deterministic and replayable, so it must run in the same seeded, virtual-clock, sorted-order core as
OODA. The coordinator's "subscription" is simply: during its `stepCoordinators` pass it reads the same
in-engine fold maps (its localized state) that prior dispatches built.

### New event types (add to the closed union + zod + every exhaustive switch)

| Event | Stream | Payload (sketch) | Emitter |
|-------|--------|------------------|---------|
| `ActionSuggested` | `coordinator-<centerId>` | `{ suggestionId, centerHubId, targetKind: "truck"\|"hub", targetId, action: "reroute"\|"hold"\|"consolidate"\|"dispatch"\|"refuel-now"\|…, params, rationale, occurredAt }` | `stepCoordinators` |
| `SuggestionAccepted` | `<target stream>` (e.g. `trailer-T001`) | `{ suggestionId, targetId, occurredAt }` | `stepAgents` (the target's OODA Decide) |
| `SuggestionRejected` | `<target stream>` | `{ suggestionId, targetId, reason: "fuel"\|"hos"\|"road-closure"\|"infeasible", occurredAt }` | `stepAgents` |
| (binding action) | `<target stream>` | reuse/extend existing binding events (`TrailerDeparted` reroute) or add a new one (`TrailerHeld`) | `stepAgents`, in the SAME pass as `SuggestionAccepted` |

Closed-union touch-list for EACH new event (build fails otherwise):
`domain-event.ts:178` (union) · `events/schemas.ts` (zod) · `events/index.ts` (re-export) ·
`rolling/scope.ts:27,94` (`hubsOf`/`trailersOf` exhaustive switches — classify the new events as
scope-neutral or scoping) · `inline.ts` `affected*` switches (only if a projection folds them).

### Deterministic accept/reject arbitration

The handshake stays deterministic because it is **two ordered passes in the same tick**, both seeded
and both reading in-engine fold state — no async, no wall-clock:

```
tick T:
  stepCoordinators pass (sorted by centerId):
    each coordinator folds events since its cursor → emits ActionSuggested (seq order fixed)
  stepAgents pass (sorted by agentId):
    each agent reads ActionSuggested addressed to it (from a pending map),
    evaluates LOCAL feasibility it alone knows (fuel = odometerByTrailer/legMilesFor;
        HOS = clockByDriver/remainingLegalDriveMinutes; road-closure = a seeded scenario flag),
    emits SuggestionAccepted + the binding event, OR SuggestionRejected.
```

Feasibility checks reuse existing pure engine state: fuel via `odometerByTrailer`/`legMilesFor`
(`engine.ts:728`), HOS via `clockByDriver` + `remainingLegalDriveMinutes` (`engine.ts:867`,
`@mm/domain`). Road-closure can be a seeded scenario knob (a new salted substream, or a deterministic
scenario injection mirroring `applyScenario`). Because every input is deterministic, the accept/reject
decision is byte-stable per (model, seed).

**Suggestion delivery within a tick:** the cleanest rule is that `ActionSuggested` emitted in the
`stepCoordinators` pass is consumed in the SAME tick's `stepAgents` pass via an in-engine
`pendingSuggestionsByTarget` map (added to `SerializedWorldState`). This guarantees a deterministic,
in-order handshake and is continuation-safe.

### One coordinator per regional center — YES
Bounded scope is the scaling thesis (design notes §4). One process-manager instance per center, each
folding only events touching its center's hubs/trailers, caps per-coordinator cost at
O(active-in-region), not O(total). Coordinators iterate in sorted `centerId` order in the pass.

---

## 5. Coordinator uses the optimizer (suggestion engine, not replacement)

### Relationship to today's global rolling optimizer

| | Today (v2.x) | v3.0 |
|---|---|---|
| Who triggers | `driver.ts` per-frame `coalescer.trigger` → `RollingLoop.tick` | A coordinator, per center, decides WHEN it wants a plan |
| Scope | `detectAffectedScope` over the whole tick's events | Per-center slice of the twin |
| Output | `PlanGenerated`/`PlanAccepted`/`PlanSuperseded` appended directly | Optimizer output TRANSLATED into advisory `ActionSuggested` events |
| Binding? | `PlanAccepted` is the side effect | Advisory; the agent must accept before it binds |

### Two viable wirings (recommend B; keep A as the escape hatch)

**A. Keep the optimizer in the plumbing layer (async, worker thread), feed results back as
suggestions.** The coordinator emits a lightweight `PlanRequested`-style marker (or just the scope);
the plumbing layer runs `RollingOptimizerService.runOnce` scoped to that center (worker thread,
`worker-client.ts`); the RESULT is injected into the NEXT sim chunk as `ActionSuggested` events.
**Problem:** the optimizer is deterministic (pure `runEpoch`, `rolling/types.ts:26`), but the *timing*
of its async re-entry into the stream is wall-clock — so byte-identical replay breaks unless the
result is injected at a deterministic tick. Use A only if coordinator suggestions are allowed to be
replay-fuzzy (NOT acceptable for the golden).

**B. (RECOMMENDED) Run the optimizer's PURE core synchronously inside `stepCoordinators`.** The
optimizer's `runEpoch` and its building blocks (`assignFreight`/`minCostFlow`, `routeTrailers`/VRPTW,
`selectPlan`) are **pure, deterministic, integer-arithmetic, no-wall-clock, no-RNG** functions
(`packages/optimizer/src/...`, contract in `rolling/types.ts`). A coordinator can build a **small
per-center `TwinSnapshot` from its in-engine fold state** (NOT from Postgres) and call `runEpoch`
directly in-process during its pass. The result (recommendations) is translated to `ActionSuggested`
events. This is byte-identical-replayable because the whole call chain is pure and runs at a
deterministic tick in sorted order.
  - **Cost control:** the per-center twin is small (bounded fan-out), the horizon is short
    (`DEFAULT_HORIZON_MIN = 240`, `scope.ts:22`), and coordinators run per-N-tick — so the synchronous
    cost is bounded. If profiling shows it's too heavy for the core, gate the optimizer-backed
    suggestion behind its own sub-flag and fall back to a cheap heuristic Decide.
  - **Reuse, don't fork:** call the existing `@mm/optimizer` pure functions. Do NOT reimplement
    flow/VRPTW. The only NEW code is (i) build-center-twin-from-fold and (ii) result→`ActionSuggested`.

**The global `RollingLoop` does not disappear** in v3.0 — keep it for the non-continental (flags-off)
model and as the live KPI/recommendation surface. Under the continental+coordinator flags, the
coordinators become the primary plan source and the global loop is disabled (a flag), so the two never
double-plan. Document this as a Key Decision.

---

## 6. async-queue placement (runtime plumbing ONLY — confirmed)

**Confirmed: `@alexanderfedin/async-queue` MUST NOT touch deterministic ordering.** It is a
Promise/microtask, O(1) circular-buffer, backpressured queue (`vendor/async-queue/src/index.ts:24`;
`enqueue` awaits when full at `:117`). Microtask scheduling order is NOT the sim's `(fireTick, seq)`
order, so any use inside `runToHorizon` / `dispatch` / `emit` would make replay non-deterministic. It
lives strictly **below the core**, in `api/src/`.

### The 1–3 best insertion points (all in the wall-clock plumbing layer)

1. **Worker–optimizer handoff** (best fit). Today `worker-client.ts` correlates replies by an
   incrementing id and `makeCoalescedRunner` (`coalesced-runner.ts`) drops to a single-flight +
   dirty-coalesce. An `AsyncQueue<EpochJob>(maxSize=1)` between the driver and the worker provides
   proper **backpressure** (the producer awaits when the worker is busy) instead of
   coalescing-by-dropping — cleaner than the hand-rolled busy/pending state machine, and bounded
   memory. Wrap or replace `coalesced-runner.ts`'s buffer.
2. **DB write-batching** for the per-tick keyed upserts (`inline.ts` appliers; the ~40ms/event
   residual noted in v2.0 debt + design notes "carry-over"). An `AsyncQueue` of pending upsert-batches
   lets a single DB-writer consumer drain at its own pace with backpressure, decoupling the fold from
   the append, instead of awaiting each upsert inline in `driveSimulationPaced.foldFrame`.
3. **ws backpressure** (`api/src/ws/`). One `AsyncQueue<Delta>` per client bounds per-socket buffer
   growth; a slow client applies backpressure to its own queue (drop-oldest or block-frame) without
   stalling the broadcast to fast clients. The driver already broadcasts exactly one delta/frame
   (`driver.ts:794`); the queue makes the per-client send non-blocking + bounded.

(Continuous-loop chunk handoff — between `advanceOneChunk()` and the frame drain in
`driveSimulationOpenEnded` — is a *possible* 4th site but lower value; the window slice already bounds
memory.)

**Determinism guard for all three:** these sit on the `SimulatedEvent[]` AFTER it leaves the core, or
on DB/ws side effects. The event ORDER handed to `appendToStream` must remain the engine's order;
async-queue is only for *rate/backpressure*, never *reordering*. Add a test asserting the append order
equals the generation order with the queue in place.

---

## 7. New goldens + flag-gating strategy

### Flag pattern (follow the existing one exactly)
Every v3.0 feature is an opt-in option on `SimulateOptions` (`engine.ts:158`), DEFAULT OFF, checked
with strict `=== true` (never `??`/`||` — see the `outboundDeliveryEnabled` comment, `engine.ts:566`).
Substreams constructed ONLY when on. This is the proven pattern that kept 8 prior features
byte-identical.

New flags (suggested):
`continentalTopology` · `oodaAgentsEnabled` · `coordinatorsEnabled` (implies the above) ·
`coordinatorUsesOptimizer` (sub-flag of coordinators).

### Golden strategy
1. **Flags-off regression gate (carries from v2.0):** the `DET-01`/`DET-02` tests
   (`determinism.unit.test.ts:194,128`) must STILL produce `3920accc…` for
   `simulate({seed:42,durationTicks:10000})` with all v3.0 flags absent AND explicit-false. Add an
   explicit-false case per new flag (mirroring `consolidationEnabled:false` /
   `outboundDeliveryEnabled:false` at `:212,224`).
2. **New per-feature goldens:** each feature gets its OWN committed SHA-256, captured from a small
   fixed `(seed, durationTicks, flags)` run, in its own `*-determinism.unit.test.ts` (mirroring
   `consolidation-determinism.unit.test.ts`, `outbound-determinism.unit.test.ts`). Order:
   `continental-determinism` → `ooda-determinism` → `coordinator-determinism`. Keep hub count small
   for the golden (a 12–20 hub continental fixture) so the hash is fast; the full ~100-hub run is a
   perf test, not a golden.
3. **Continuation-equivalence per feature:** the chunked-vs-all-at-once hash test must pass with each
   new flag on (proves the new `SimTask` variants + `SerializedWorldState` additions serialize
   correctly). This is the real witness that agent/coordinator state is fully captured.
4. **Cross-arch note:** the existing log-normal `Math.exp` ULP caveat (`determinism.unit.test.ts:116`)
   applies to any new continuous math in OODA Decide. Prefer integer/threshold decisions in agents to
   avoid widening the cross-arch surface.

---

## 8. twin-snapshot incremental cursor-fold (carry-over debt)

### The problem (verified)
`buildTwinSnapshot` (`api/src/optimizer/twin-snapshot.ts:346`) does, PER optimizer epoch:
- `computeMilesSinceRefuel` → `readAll(es, 0n)` — **full log scan** (`twin-snapshot.ts:100`)
- `buildInductionDeadlines` → `readAll(es, 0n)` — **full log scan** (`:125`)
- 4 full table reads (`trailer_state`, `hub_inventory`, `driver_status`, routes/departures)

Two O(log) scans per epoch ⇒ O(log²) over a run. With N centers × many agents the log grows faster, so
this degrades superlinearly. (Bounded by `optimizerEveryTicks`, hence "secondary," but it gets worse at
continental scale.)

### Recommendation: cursor-fold the two derived maps; materialize as projections

1. **Make `milesSinceRefuel` and `inductionDeadlines` PROJECTIONS, not per-epoch folds.** They are
   already computed by pure reducers (`trailerFuelReducer`, and a trivial last-write map for induction
   deadlines). Add them to the `applyInline` key-scoped fold path (`inline.ts:663` `APPLIERS`) so they
   are maintained incrementally as events land — exactly like `trailer_state` / `hub_inventory`. Then
   `buildTwinSnapshot` READS two small tables instead of folding the whole log. This is the same move
   v2.1 made for the O(n²) projection fold; apply it here.
2. **If keeping the in-snapshot fold (smaller change):** hold a module-level `{ cursor, state }` and on
   each epoch `readAll(es, cursor)` (only NEW events), fold forward, advance `cursor`. The snapshot
   builder becomes O(Δevents) per epoch instead of O(log). Caveat: this introduces per-process mutable
   state, so it must be (a) keyed to the run and (b) reset on rebuild/replay — a projection (option 1)
   is cleaner and reuses the existing checkpoint machinery (`projection_checkpoints`).
3. **Per-center snapshots (v3.0-native):** once coordinators build per-center twins from in-engine fold
   state (§5B), the heavy Postgres `buildTwinSnapshot` is needed only for the *global* loop and the API
   read surface — its frequency drops, easing the pressure regardless. Prefer option 1 for the global
   loop; build coordinator twins from the in-engine fold (no DB).

**Determinism:** projections fold in `global_seq` order via pure reducers (`inline.ts:46` doc), so the
incremental result equals the full fold (rebuild-equivalence, FND-04). No behavior change to the event
stream — this is a read-side perf change, not a model change, so it does NOT need a new golden (the
existing projection-golden-replay int test covers it).

---

## 9. Integration points — consolidated (new vs modified)

### NEW components
| Component | Location | Purpose |
|-----------|----------|---------|
| `generateBigCityHubs()` | `simulation/src/network/hubs.ts` | static 1–3/state dataset → ~80–130 hubs (pure) |
| `pickRegionalCenters()` / `assignSpokesToNearestCenter()` | `simulation/src/network/centers.ts` (new) | deterministic center selection + nearest mapping |
| `stepAgents` `SimTask` + OODA agent module | `continuation.ts` (variant) + `simulation/src/ooda/` (new) | per-agent Observe→Orient→Decide→Act |
| `stepCoordinators` `SimTask` + coordinator module | `continuation.ts` (variant) + `simulation/src/coordinator/` (new) | per-center process manager |
| `ActionSuggested` / `SuggestionAccepted` / `SuggestionRejected` (+ any new binding events) | `domain/src/events/` (schemas + union + index) | the advisory handshake contract |
| build-center-twin-from-fold + result→suggestion | `simulation/src/coordinator/optimize.ts` (new) | calls pure `@mm/optimizer` `runEpoch` in-process (§5B) |
| Per-agent / per-coordinator state in `SerializedWorldState` | `continuation.ts:103` | continuation-safe agent memory + `pendingSuggestionsByTarget` map |
| New salts (`OODA_RNG_SALT`, road-closure, …) | `engine.ts:78` block | seeded substreams, pairwise-distinct (extend the salt-collision test) |
| Per-feature determinism + continuation-equivalence tests | `simulation/test/*-determinism.unit.test.ts` | new goldens |
| 2 new projections (`trailer_fuel_miles`, `induction_deadline`) | `projections/src/` + `inline.ts` `APPLIERS` | incremental cursor-fold for §8 |
| `AsyncQueue` wiring | `api/src/optimizer/` + `api/src/ws/` + `api/src/sim/` | backpressure (plumbing only) |

### MODIFIED components
| Component | File:line | Change |
|-----------|-----------|--------|
| `buildRoutes` / `buildTransitParamsByLeg` | `routes.ts:283,141` | single-center star → multi-center spoke↔center + backbone |
| engine center/spokes + flow tasks | `engine.ts:710` + flow `SimTask` variants | `centerOf(spoke)` map; route freight through nearest+dest centers |
| `dispatch` switch + bootstrap schedule | `engine.ts:1965,2012` | add `stepAgents`/`stepCoordinators` cases + seed them |
| `SimulateOptions` | `engine.ts:158` | add the new opt-in flags (strict `=== true`) |
| `detectAffectedScope` + `hubsOf`/`trailersOf` | `scope.ts:27,94,121` | classify new events; per-center scope partition |
| `TwinSnapshot.centerHubId` | `rolling/types.ts:153` | → `centerHubIds?` (additive) |
| `deriveCenterHub` | `twin-snapshot.ts:555` | return center SET |
| `twin-snapshot.ts` heavy scans | `twin-snapshot.ts:100,125` | read the new projections instead of full-log fold (§8) |
| Driver / coalescer / ws | `driver.ts`, `coalesced-runner.ts`, `ws/` | async-queue backpressure (plumbing) |

### Data-flow changes
- **Topology:** `RouteRegistered` bootstrap now emits spoke↔center + center↔center legs (more legs,
  same shape).
- **New handshake flow:** `stepCoordinators` → `ActionSuggested` (stream `coordinator-<id>`) →
  `stepAgents` reads it → `SuggestionAccepted`+binding OR `SuggestionRejected` (stream `<target>`). All
  in-tick, all logged, all deterministic.
- **Optimizer flow:** under the coordinator flag, plans originate from per-center in-fold `runEpoch`
  calls (synchronous, pure) rather than (only) the global async `RollingLoop`.
- **Read-side:** two derived maps move from per-epoch full-log folds to incremental projections.

---

## 10. Suggested build order (dependency-respecting)

```
Phase A — Multi-center topology  [foundation]
  1. generateBigCityHubs + pickRegionalCenters + assignSpokesToNearestCenter (pure, tested)
  2. buildRoutes/buildTransitParamsByLeg multi-center + great-circle
  3. engine centerOf + flow-task routing through centers
  4. twin-snapshot multi-center; per-center scope partition in detectAffectedScope
  5. FLAG continentalTopology + NEW golden (small continental fixture); DET-01 flags-off still 3920accc
        ▼ (everything below assumes a center per spoke)
Phase B — OODA step-agents
  6. SimTask stepAgents + dispatch case + bootstrap schedule (cadence constant)
  7. per-agent seeded substream (OODA_RNG_SALT ^ hash(agentId)); salt-collision test
  8. Observe(fold maps)/Orient/Decide/Act(emit); sorted agent iteration
  9. agent state into SerializedWorldState; continuation-equivalence test
 10. FLAG oodaAgentsEnabled + NEW golden + flags-off regression
        ▼ (agents must exist to accept/reject)
Phase C — Coordination centers (process managers)
 11. ActionSuggested/SuggestionAccepted/SuggestionRejected events (union+zod+switches)
 12. SimTask stepCoordinators (one per center, sorted) + in-fold localized state
 13. in-tick handshake: pendingSuggestionsByTarget map (SerializedWorldState)
 14. agent local-feasibility accept/reject (fuel/HOS/road-closure — reuse engine state)
 15. FLAG coordinatorsEnabled + NEW golden + continuation-equivalence
        ▼ (coordinators exist; now let them use the optimizer)
Phase D — Coordinator ↔ optimizer (suggestion engine)
 16. build-center-twin-from-fold; call pure @mm/optimizer runEpoch in-process
 17. result → ActionSuggested translation; disable global RollingLoop under the flag
 18. FLAG coordinatorUsesOptimizer + golden
        ▼ (independent; can interleave with C/D)
Phase E — Perf + plumbing (parallelizable with C/D)
 19. incremental cursor-fold projections for twin-snapshot (§8)
 20. async-queue: worker handoff → DB write-batching → ws backpressure (§6)
 21. scale viz (100+ hubs + backbones + suggestion overlays); sustained continental-run perf test
```

Phase A is a hard prerequisite for B/C/D. B precedes C (agents must exist to arbitrate). D needs C. E is
independent and can run alongside C/D (it touches the plumbing/read side, not the model).

---

## 11. Determinism-preservation checklist (per new behavior)

| New behavior | Determinism mechanism |
|--------------|----------------------|
| Big-city hubs / centers / nearest-assignment | Pure functions of a static dataset (no clock/RNG) — byte-stable like `USA_HUBS` |
| Multi-center routes | `greatCircle` (pure) + stable directed-pair order |
| OODA agent step | `SimTask` on `(fireTick,seq)` queue · sorted agent iteration · per-agent seeded substream · Observe = pure read of fold maps at pass entry |
| Coordinator process manager | In-fold `SimTask` (NOT async) · sorted center iteration · localized state from logged events only · emits logged `ActionSuggested` |
| Accept/reject handshake | Two ordered passes same tick · feasibility from existing deterministic engine state · in-tick `pendingSuggestionsByTarget` map |
| Coordinator uses optimizer | Pure `runEpoch` called synchronously in-fold at a deterministic tick |
| New stochastic draws | New salt, pairwise-distinct (salt-collision test) · substream constructed only when flag on · strict `=== true` gate |
| Continuation/resume | New `SimTask` variants + agent state in `SerializedWorldState` · continuation-equivalence hash test |
| async-queue | ONLY below the core (worker/DB/ws) · never reorders the `SimulatedEvent[]` · append-order==generation-order test |
| twin-snapshot incremental fold | Pure reducers in `global_seq` order (rebuild-equivalence) · read-side only (no new golden) |

---

## Sources

- Codebase (HIGH — primary): `packages/simulation/src/engine.ts`, `continuation.ts`, `rng.ts`,
  `network/routes.ts`, `network/hubs.ts`; `packages/domain/src/events/domain-event.ts`;
  `packages/optimizer/src/rolling/{scope,types}.ts`; `packages/api/src/optimizer/{twin-snapshot,
  live-loop,worker-client,rolling-service,coalesced-runner}.ts`; `packages/api/src/sim/driver.ts`;
  `packages/projections/src/runner/inline.ts`; `packages/simulation/test/determinism.unit.test.ts`;
  `vendor/async-queue/src/index.ts`. Verified 2026-06-26.
- `.planning/PROJECT.md`, `.planning/v3.0-DESIGN-NOTES.md` (locked decisions). HIGH.
- [Saga and Process Manager — Event-Driven.io](https://event-driven.io/en/saga_process_manager_distributed_transactions/) — process-manager-as-stateful-state-machine, choreography vs orchestration. MEDIUM (corroborates the in-fold process-manager framing).
- [Saga vs. Process Manager — DevArchive](https://blog.devarchive.net/2015/11/saga-vs-process-manager.html) — process manager has state + decides on incoming event + current state. MEDIUM.
