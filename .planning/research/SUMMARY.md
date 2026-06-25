# Research Summary — Milestone v2.0 "Complete Simulation Model"

**Project:** Middle-Mile Trailer Optimization Platform
**Domain:** Deterministic, event-sourced discrete-event logistics simulation
**Researched:** 2026-06-23
**Confidence:** HIGH (all four research files grounded in live codebase reads)

---

## Executive Summary

v2.0 closes four tightly-coupled gaps in an already-shipped, deterministic, event-sourced TS/Node simulation: making the run open-ended (today it halts at ~120 ticks), adding freight that enters from outside (today only the center hub spawns packages), adding a genuine terminal event when freight leaves a destination hub (today `PackageArrivedAtHub` is the terminal — which is ambiguous for transit stops), and making the return trailer leg carry real consolidation freight (today trailers return empty). All four can be realized through pure engine extensions — no new runtime dependencies are required. The stack verdict is unambiguous: extend the existing `EventQueue`/`generate()` core with opt-in feature flags, two new RNG salt constants, and a renamed pending-manifest data structure. Nothing else.

The recommended build order, confirmed by convergent reasoning across all four researchers, is CONT → IND → FLOW → OUT. Continuous operation is the foundation everything else requires; external induction introduces the new `PackageInducted` domain event that bidirectional flow reuses for spoke-origin freight; bidirectional flow (FLOW-*) is where the optimizer, projections, and engine all touch simultaneously and is the highest-integration phase; outbound delivery (OUT-*) is relatively self-contained — one new terminal event type, a scheduled post-arrival dwell, and projection purge logic. The slight disagreement between researchers (Architecture put OUT last; Features/Pitfalls paired IND+OUT then FLOW) resolves to CONT → IND → FLOW → OUT because FLOW-* requires IND-* freight to exist at spokes and the optimizer changes for FLOW-* are more entangled than the single-event OUT-* addition.

The keystone risk is determinism integrity. Two new RNG salt constants (`INDUCTION_RNG_SALT`, `OUTBOUND_RNG_SALT`) must be pairwise-distinct from all six existing salts and asserted in the existing salt-collision test before any induction draw is written. A long-horizon floating-point golden (10,000 ticks across x86 and ARM) must pass before continuous operation is declared done. Every new domain event type must be round-trip tested through `validate()`. Projection memory is bounded by the `PackageDelivered` purge — without it, continuous operation grows projection tables without bound. These are not speculative risks; they are specific failure modes traced to actual source lines.

---

## Canonical Domain Events (Reconciled Decision)

The four researchers proposed conflicting names for three new domain events. The existing naming convention in `@mm/domain` uses `PascalCase`, `Package` as the entity prefix for package lifecycle events, and concrete verb phrases (`PackageCreated`, `PackageArrivedAtHub`, `TrailerDeparted`). The reconciled canonical set follows that convention:

### New Event 1: `PackageInducted` — NEW event type

**Rationale for name:** Architecture and Pitfalls both proposed `PackageInducted`; Features proposed `FreightInducted`. Existing events use `Package` as the entity prefix — not `Freight`. `PackageInducted` is consistent. This is a NEW event type (not a reuse of `PackageCreated`) because it carries `slaDeadlineIso` and `externalOriginRef` that `PackageCreated` does not, and because the two events have distinct semantics: `PackageCreated` = internal simulation construction; `PackageInducted` = first network-visible entry of externally-originated freight.

**Key fields:**
```
PackageInducted {
  packageId:          string   // new package entering the network
  inductionHubId:     string   // spoke (or center) where it enters from outside
  destHubId:          string   // final destination hub
  sizeClass:          SizeClass
  weight:             number   // kg
  slaDeadlineIso:     string   // ISO-8601 delivery deadline (drives optimizer priority)
  rfidTagId?:         string   // optional
  externalOriginRef?: string   // deterministic audit ref, e.g. "EXT-P00042"
  occurredAt:         string
}
```

**Stream:** `package-${packageId}` — same pattern as `PackageCreated`.

### New Event 2: `PackageDelivered` — NEW event type

**Rationale for name:** Architecture proposed `PackageDelivered`; Features proposed `FreightDelivered`; Pitfalls proposed `PackageDeliveredOut`. `PackageDelivered` follows the `Package` prefix convention. `PackageDeliveredOut` is redundant ("out" is implied by "delivered"). `FreightDelivered` breaks the existing `Package*` convention.

**Key fields:**
```
PackageDelivered {
  packageId:    string
  hubId:        string    // destination hub where last-mile handoff occurs
  deliveryRef:  string    // deterministic ref, e.g. "DEL-P00042"
  onTime:       boolean   // deliveredAt <= slaDeadlineIso
  occurredAt:   string
}
```

**Lifecycle position:** fires AFTER `PackageArrivedAtHub` at the destination hub, after a seeded outbound dwell (`OUTBOUND_RNG_SALT` substream). `PackageArrivedAtHub` retains its current meaning (arrived at ANY hub, transit or destination) and is no longer terminal. `PackageDelivered` is the single authoritative terminal.

**Effect on projections:** `packageLocationReducer`, `hubInventoryReducer`, and `zoneEstimateReducer` must DELETE (not upsert) the package row on this event. This is the bounded-memory mechanism for continuous operation.

### Spoke-origin consolidation freight: NOT a new event type

Architecture proposed a separate `SpokeFreightCreated` event for spoke-origin consolidation freight. This is REJECTED after reconciliation. A spoke-originated package inducted at a spoke is `PackageInducted` with `inductionHubId` set to the spoke. Introducing a separate event type for the same real-world action creates unnecessary projection branching. The distinction between "externally inducted" and "spoke-originated consolidation" is captured by `inductionHubId` (spoke vs center) and `destHubId`, not by separate event types.

**The two-queue manifest model (from Pitfalls)** does not require a new event type. It requires a structural addition in `engine.ts`: a new `pendingAtSpoke: Map<spokeHubId, string[]>` alongside the existing `pendingBySpoke: Map<spokeHubId, string[]>`. Spoke→center consolidation trailers drain `pendingAtSpoke`; center→spoke distribution trailers drain `pendingBySpoke`. Empty `pendingAtSpoke` is valid — return leg departs with empty manifest.

### Existing events whose context widens in v2.0

| Event | Change |
|-------|--------|
| `PackageCreated` | Unchanged, center-origin only |
| `PackageArrivedAtHub` | Now intermediate (not terminal) at final destination hub. Terminal is `PackageDelivered`. Schema unchanged. |
| `TrailerDeparted` | `fromHubId`/`toHubId` already support both directions. Schema unchanged. Now also fires as designed spoke→center consolidation legs (not only over-carry exceptions). |
| `PackageScanned` | `scanType: "outbound"` now also fires at spoke hubs before consolidation departures. Schema unchanged. |

---

## Key Findings

### Stack Verdict

**Zero new runtime dependencies.** The specific extension points are:

1. **Engine stop-signal:** Replace `if (action.fireTick > durationTicks) break` with a shared `stopped` boolean, gated by `runUntilStopped?: boolean`. The `durationTicks` path is unchanged — golden tests continue using it. ~10 LOC.

2. **Streaming emit:** Switch `generate()`'s `out: SimulatedEvent[]` accumulation to an `onEvent` callback. The existing `simulate()` wrapper collects into an array for golden tests. ~15 LOC.

3. **Two new RNG salt constants:**
   ```typescript
   export const INDUCTION_RNG_SALT = 0x9f_2e_a4_c8; // PackageInducted arrival draws
   export const OUTBOUND_RNG_SALT  = 0x7b_1c_d3_f6; // PackageDelivered dwell draws
   ```
   Assert pairwise-distinct from all 6 existing salts in the salt-collision test. No new RNG library.

4. **Two-queue manifest model:** Add `pendingAtSpoke: Map<spokeHubId, string[]>` alongside existing `pendingBySpoke`. Spoke→center trailers drain `pendingAtSpoke`. Empty is valid.

5. **Bidirectional route registration:** `buildRoutes()` emits `RouteRegistered` for both directions. Reverse geometry = existing polyline with coordinates reversed — no new ORS call.

**What NOT to add:** No DES framework (SimScript/SIM.js/simmer/des.js — stale 2021-2022, coroutine model breaks determinism). No Kafka/Redis/BullMQ. No PCG/xoshiro/ts-seedrandom (would invalidate all existing goldens). No actor library. No Postgres snapshotting for v2.0 (demo runs hours, not days; 10k events is trivial for Postgres).

All existing dependencies remain at pinned versions. Version compatibility table unchanged from v1.x.

### Expected Features

**Must ship — P1:**
- CONT-01: Open-ended run loop (stop-signal replaces `durationTicks`)
- CONT-02: Periodic induction trigger at multiple hubs (self-rescheduling)
- CONT-03: Sim-day / cycle counter in ws state diff + KPI panel
- IND-01: `PackageInducted` domain event in closed union
- IND-02: Induction at spoke hubs (not center-only)
- IND-03: `destHubId` + `slaDeadlineIso` on inducted package
- FLOW-01: Spoke-origin trailer departures carry freight (`pendingAtSpoke` drained)
- FLOW-02: Center inbound unload + re-sort handles spoke→center arrivals
- FLOW-03: Existing center→spoke distribution continues unbroken
- OUT-01: `PackageDelivered` domain event (terminal last-mile tender)
- OUT-02: Destination hub detection triggers `PackageDelivered` after dwell
- OUT-03: `onTime: boolean` on `PackageDelivered`
- VIZ-07: Spoke→center trailers show non-empty freight manifests on map

**Add if time allows — P2:**
- OUT-04: Delivered-out counter + on-time % KPI panel widget
- CONT-04: Sort wave / cut-off window rhythm (burst-quiet-burst departure pattern)
- FLOW-04: Per-hub inventory balance display (cross-dock utilization heat)

**Explicitly deferred:**
- IND-04: Mixed-direction same-hub local short-circuit deliveries
- CONT-05: Pacer safety valve for sustained high-speed multi-cycle runs
- Returns / reverse logistics (third flow direction)
- Last-mile delivery routing (door-level VRP to customers)
- Per-wave per-hub SLA differentiation

### Architecture Approach

v2.0 is an additive extension to the existing pnpm monorepo. All architectural patterns follow established conventions: new events via `eventSchema()` factory with `.strict()` payloads, new reducer cases with `assertNever` exhaustiveness guards that fail the build until handled, new feature flags on `SimulateOptions` that are off-by-default, and new ws message types in the typed protocol. The closed `DomainEvent` discriminated union is the integration seam — adding `PackageInducted` and `PackageDelivered` to it ripples to every `switch(event.type)` in the codebase, which is by design and enforced by `contract.assert.ts`.

**Touched packages and approximate change sizes:**

| Package | Change nature | Approx. size |
|---------|--------------|-------------|
| `@mm/domain` | 2 new event schemas + union members; update `contract.assert.ts` | ~50 LOC |
| `@mm/simulation` | Stop-signal, streaming emit, `pendingAtSpoke`, `inductionEnabled`/`outboundDeliveryEnabled` flags, 2 new salts, bidirectional route registration | ~125 LOC |
| `@mm/projections` | Handle new events in all reducers (DELETE on `PackageDelivered`); new `packageLifecycleReducer`; checkpoint table schema | ~100 LOC |
| `@mm/optimizer` | New events in `hubsOf()` in `scope.ts`; `deadlineMin?` on `TwinBlock`; LRU eviction on idempotency map | ~40 LOC |
| `@mm/api` | New ws message types; sim-driver passes new flags; projection watermark checkpoint wiring | ~50 LOC |
| `@mm/web` | `inductionLayer`, `deliveryLayer`, direction field on trailer animation, new ws message handlers | ~80 LOC |

**New components introduced:**
- `packageLifecycleReducer` in `@mm/projections` — per-package state machine (`pre-inducted | inducted | in-transit | at-hub | delivered`); feeds optimizer twin builder
- `inductionLayer` in `@mm/web` — pulsing OL circle on `PackageInducted` ws message
- `deliveryLayer` in `@mm/web` — hub highlight on `PackageDelivered` ws message
- `projection_checkpoints` Postgres table — watermark for catch-up projections (prevents O(log-size) rebuild on restart)

### Critical Pitfalls

**P1 — RNG salt collision breaks golden determinism** [Phase 1]
Adding induction draws to an existing substream, or using a colliding salt, silently shifts every downstream draw. Prevention: assign `INDUCTION_RNG_SALT` and `OUTBOUND_RNG_SALT` before writing any draw; extend salt-collision assertion test to cover all 8 salts pairwise; gate `inductionRng` construction on `inductionEnabled` exactly as `fuelRng` is gated.

**P2 — Projection memory explosion without `PackageDelivered` purge** [Phase 4]
Under continuous induction, `package_location`, `hub_inventory`, and `zone_estimate` grow without bound. Detection (`runDetection`) scans ALL rows — cost grows with total-packages-ever-inducted. Prevention: `PackageDelivered` must DELETE rows (not upsert); scope detection to `is_active = true` packages. The `assertNever` exhaustiveness guard enforces reducer coverage at build time.

**P3 — Long-run floating-point drift** [Phase 1 acceptance gate]
Log-normal transit draws use `Math.exp`/`Math.log` (implementation-defined). Over 10,000+ ticks on ARM vs x86, a one-tick drift cascades through all downstream event timing. Prevention: add a `simulate({ seed: 42, durationTicks: 10000 })` golden hash test on both CI architectures before CONT-* is declared done. If hashes diverge, switch to integer lookup tables.

**P4 — Optimizer thrash + idempotency map memory growth** [Phase 1 LRU fix; Phase 3 persistence]
Continuous induction triggers optimizer epochs indefinitely. The in-memory `(epoch, scopeHash)` idempotency map (known v1.0 tech debt) grows without bound and is lost on restart, producing duplicate `PlanAccepted` events. Prevention: (a) LRU eviction (500-entry cap) in Phase 1; (b) `optimizer_idempotency` Postgres table in Phase 3; (c) verify `detectAffectedScope` for `PackageInducted` scopes to `[inductionHubId, destHubId]` only.

**P5 — WS backpressure / snapshot size explosion** [Phase 1]
At ~7,200 ticks/hour, a backgrounded browser tab saturates its ws buffer. `buildSnapshot` on reconnect must not scan the raw event log (O(log-size)). Prevention: add `bufferedAmount > 256KB` skip-tick guard; audit `buildSnapshot` reads from Postgres projection tables only; cap snapshot to currently-active packages.

**P6 — `PackageArrivedAtHub`-as-terminal assumption baked into consumers** [Phase 4 prerequisite]
Several consumers treat the last `PackageArrivedAtHub` as terminal. Prevention: update `packageLocationReducer` first so the build fails if anything downstream uses `PackageArrivedAtHub` as terminal; add a lifecycle test asserting every package eventually emits `PackageDelivered`.

**P7 — Bidirectional double-drain / double-counting at consolidation** [Phase 3 FLOW-* success criteria]
Two trailers from the same spoke draining `pendingAtSpoke` simultaneously could produce ghost-empty manifests. Stale optimizer plan entries in `hub_inventory.staged` combined with fresh consolidation arrivals in `hub_inventory.inbound` produce double-counted freight. Prevention: `pendingAtSpoke` drained atomically per departure; `PlanSuperseded` event or supersession-aware `PlanAccepted` reducer clears stale staged entries.

---

## Implications for Roadmap

### Recommended Build Order: CONT → IND → FLOW → OUT

All four researchers converged on this sequence. The slight ordering disagreement (Architecture placed OUT last; Features/Pitfalls briefly paired IND+OUT then FLOW) resolves to CONT → IND → FLOW → OUT:
- CONT-* is prerequisite foundation — a finite sim cannot demonstrate any other feature meaningfully.
- IND-* introduces `PackageInducted`, which spoke-origin FLOW-* freight reuses; doing it before FLOW-* means FLOW-* inherits already-working projection handlers.
- FLOW-* is the highest-integration phase (engine, optimizer, projections, viz all change simultaneously) and should land as a coherent unit.
- OUT-* (`PackageDelivered` + dwell scheduling + projection purge) is the most self-contained; it lands last where its purge effect is most meaningful with all three freight types accumulating.

---

### Phase 1: Continuous Operation Foundation (CONT-*)

**Rationale:** Engine must run open-ended before any other v2.0 feature operates in a meaningful multi-cycle context. Also establishes infrastructure non-negotiables every subsequent phase depends on: backpressure, projection watermarks, LRU idempotency eviction, long-run golden.

**Delivers:**
- Open-ended `generate()` loop with stop-signal (`runUntilStopped?: boolean` option)
- Streaming `onEvent` callback (replacing `out[]` accumulation)
- Self-rescheduling induction trigger at center hub generalized to multi-cycle
- `projection_checkpoints` Postgres table + watermark-based `runCatchup`
- WS `bufferedAmount > 256KB` skip-tick backpressure guard
- `buildSnapshot` audited to read from projection tables only
- LRU eviction (500-entry cap) on optimizer idempotency map
- Long-horizon golden: `simulate({ seed: 42, durationTicks: 10000 })` passes on x86 + ARM CI
- Sim-day / cycle counter in ws state diff (CONT-03)
- Bidirectional route registration in `buildRoutes()` (spoke→center reverse legs at bootstrap — prerequisite for Phase 3)

**Addresses:** CONT-01, CONT-02, CONT-03; pitfalls P1 (salt discipline established), P3, P4 (LRU), P5
**Determinism gate:** With `durationTicks` = current value, all existing goldens pass byte-identical.

**Research flag:** Standard patterns. All integration points traced to actual source lines.

---

### Phase 2: External Induction (IND-*)

**Rationale:** Introduces the only genuinely new domain event (`PackageInducted`) and defines the pattern for spoke-origin freight. Domain event union expansion ripples to every `switch(event.type)` consumer — doing this before FLOW-* means FLOW-* inherits working projection handlers.

**Delivers:**
- `PackageInducted` event schema, type, union membership in `@mm/domain`
- `contract.assert.ts` updated to include `PackageInducted`
- `INDUCTION_RNG_SALT` constant + pairwise-distinct assertion in salt-collision test
- `inductionEnabled?: boolean` flag on `SimulateOptions`
- Per-hub induction batches firing at spokes on repeating schedule
- Packages carry `destHubId` and `slaDeadlineIso` drawn from `inductionRng` substream
- All projection reducers handle `PackageInducted` (including new `packageLifecycleReducer`)
- `detectAffectedScope` in `scope.ts` handles `PackageInducted` → `[inductionHubId, destHubId]`
- `validate()` round-trip test for `PackageInducted`
- `freightInducted` ws message type + `inductionLayer` pulsing-circle animation in `@mm/web`
- `deadlineMin?` (optional, additive) added to `TwinBlock` for optimizer SLA awareness

**Addresses:** IND-01, IND-02, IND-03; pitfalls P1 (INDUCTION_RNG_SALT sealed), P6
**Determinism gate:** `inductionEnabled: false` (default) → ZERO new events → existing golden byte-identical.

**Research flag:** Standard patterns. Event-union expansion and reducer exhaustiveness-guard patterns are well-established in the codebase.

---

### Phase 3: Bidirectional Freight / Spoke→Center Consolidation (FLOW-*)

**Rationale:** Highest-integration phase — engine manifest model, optimizer scope and twin, projections, and map viz all change simultaneously. Placed third because: (a) needs `PackageInducted` (Phase 2) for spoke-origin freight; (b) needs bidirectional routes registered at bootstrap (Phase 1); (c) optimizer changes are more entangled than the OUT-* terminal event, so FLOW-* should land as a coherent unit.

**Delivers:**
- `pendingAtSpoke: Map<spokeHubId, string[]>` in `engine.ts` (spoke→center manifest queue)
- `consolidationEnabled?: boolean` flag on `SimulateOptions`
- Spoke→center `TrailerDeparted` as designed flow (draining `pendingAtSpoke`), not only over-carry exception
- Center hub inbound unload + re-sort on spoke→center `TrailerArrivedAtHub`
- All projection reducers handle bidirectional trailer events
- Optimizer `detectAffectedScope` and `buildTravelModel` verified for both directions
- `isFrozen` freeze-window semantics verified for spoke→center return trailers
- `optimizer_idempotency` Postgres table + migration (persistent idempotency across restarts)
- `PlanSuperseded` event or supersession-aware `PlanAccepted` reducer (clears stale `staged` entries)
- Detection (`runDetection`) scoped to `is_active = true` packages only
- `direction: 'outbound' | 'consolidation'` field on ws trailer tick; map colors consolidation trailers distinctly (VIZ-07)
- Empty-manifest `TrailerDeparted` accepted and tested (valid return when no consolidation freight)
- Two-trailer double-drain test: two trailers from same spoke drain `pendingAtSpoke` independently

**Addresses:** FLOW-01, FLOW-02, FLOW-03, VIZ-07; pitfalls P4 (persistence), P7
**Determinism gate:** `consolidationEnabled: false` (default) → ZERO new events.

**Research flag:** Needs careful test design. The three OPEN DECISIONS (see below) must be resolved before requirements are written for this phase. The `PlanSuperseded` / supersession-aware `PlanAccepted` pattern is not yet in the codebase — warrants a brief design session during requirements.

---

### Phase 4: Outbound Delivery (OUT-*)

**Rationale:** Most self-contained phase — one new event type, a scheduled post-arrival dwell, and projection purge logic. Placing it last allows the purge to operate on the richest set of package types: center-created, inducted, and consolidated.

**Delivers:**
- `PackageDelivered` event schema, type, union membership in `@mm/domain`
- `OUTBOUND_RNG_SALT` constant + assertion in salt-collision test
- `outboundDeliveryEnabled?: boolean` flag on `SimulateOptions`
- Post-arrival dwell scheduling: after `PackageArrivedAtHub` at `destHubId`, schedule `PackageDelivered` at `arriveTick + outboundDwellTicks` (drawn from `outboundRng` substream)
- `onTime` flag: `deliveredAt <= slaDeadlineIso`
- ALL projection reducers handle `PackageDelivered` with DELETE semantics: `packageLocationReducer`, `hubInventoryReducer`, `zoneEstimateReducer`, `packageLifecycleReducer`
- Optimizer twin builder filters out `PackageDelivered` packages from `TwinSnapshot.blocks`
- `freightDelivered` ws message type + `deliveryLayer` hub-highlight animation in `@mm/web`
- Lifecycle ordering test: `PackageDelivered` always follows `PackageArrivedAtHub` for same package
- Terminal completeness test: every package emits `PackageDelivered` within sim horizon when enabled
- OUT-04 (P2): delivered-out counter + on-time % in KPI panel widget

**Addresses:** OUT-01, OUT-02, OUT-03, OUT-04 (if time allows); pitfalls P2 (complete), P6
**Determinism gate:** `outboundDeliveryEnabled: false` (default) → ZERO new events.

**Research flag:** Standard patterns. Only subtlety: `slaDeadlineIso` must be queryable at delivery time (see Gaps to Address).

---

### Phase Ordering Summary

- CONT-* first: prerequisite for all other features to have observable multi-cycle behavior.
- IND-* second: `PackageInducted` is the domain anchor for spoke-origin freight; defining it before FLOW-* lets reducers already handle it when FLOW-* lands.
- FLOW-* third: highest-integration change; benefits from IND-* freight already flowing through the system.
- OUT-* fourth: cleanest self-contained addition; its projection-purge effect is most meaningful when all three freight types are accumulating.

### Research Flags

Needs deeper planning attention during requirements:
- **Phase 3 (FLOW-*):** Three open decisions must be resolved before requirements are written. The `PlanSuperseded`/supersession-aware pattern warrants a design session.
- **Phase 3 (FLOW-*):** Optimizer freeze-window behavior for spoke→center trailers should be validated against the existing `isFrozen` implementation before the phase is planned.

Standard patterns (skip research phase):
- **Phase 1 (CONT-*):** Engine stop-signal, streaming callback, projection watermarks, WS backpressure — all well-documented with clear integration points.
- **Phase 2 (IND-*):** Event union expansion, RNG salt addition, reducer exhaustiveness guard — all follow established codebase patterns.
- **Phase 4 (OUT-*):** New event type + scheduled dwell + projection purge — same patterns as IND-*.

---

## Open Decisions (Must Be Resolved in Requirements Step)

### Decision 1: Does `PackageInducted` REPLACE or COEXIST with `PackageCreated`?

**Option A — Coexist (recommended):** `PackageCreated` = internal center-origin spawn (unchanged); `PackageInducted` = first network-visible entry of externally-originated freight. Two distinct events. Existing golden tests untouched. Consumers handle both events (similar but different fields).

**Option B — Replace:** `PackageInducted` supersedes `PackageCreated` everywhere. Center-origin packages become inducted at the center with `inductionHubId = centerId`. Simpler projection logic. Requires migrating or toggling all `PackageCreated` callsites.

**Recommendation:** Coexist (Option A). Preserves golden tests and the semantic distinction between "simulation spawns a package" and "external shipper tenders freight."

### Decision 2: Spoke→spoke paths — route via center or add direct routes?

**Option A — Hub-and-spoke via center (recommended):** All cross-spoke freight routes Spoke A → Center → Spoke B. No new route registrations. Existing time-expanded graph handles multi-hop via the center node. The existing optimizer assigns first-leg to spoke→center and re-manifests at center for spoke B.

**Option B — Direct spoke↔spoke:** Register direct spoke→spoke routes. Changes the time-expanded graph edge set. More complex optimizer behavior.

**Recommendation:** Hub-and-spoke (Option A). The existing topology and optimizer assume a star graph. The center cross-dock is a feature demonstrating consolidation value, not a limitation.

### Decision 3: Does the optimizer pick up inducted freight automatically or need a new demand source?

**Option A — Automatic via projection (recommended):** `buildTwinSnapshot` queries `hub_inventory` for inbound packages at each hub. `PackageInducted` populates `hubInventory[spoke].inbound` via the same reducer path as `PackageArrivedAtHub`. The scope trigger (`detectAffectedScope` returning `[inductionHubId, destHubId]` on `PackageInducted`) fires the epoch. No new optimizer twin concept.

**Option B — Explicit new demand source:** The optimizer's twin model adds `spokeOriginDemand: Record<spokeId, TwinBlock[]>`. Induction events explicitly populate this demand.

**Recommendation:** Automatic via projection (Option A). The optimizer already reads `hub_inventory` inbound counts. `PackageInducted` adds packages to `inbound` via the same handler that `PackageArrivedAtHub` uses. No new twin concept needed.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All researchers grounded in actual source files (`engine.ts`, `rng.ts`, `schemas.ts`). "Zero new deps" conclusion is definitive. |
| Features | HIGH | Grounded in real carrier operations + existing codebase. Feature list complete for the 4 audited gaps. |
| Architecture | HIGH | Full codebase read: `engine.ts` (1,267 LOC), all reducer files, optimizer `scope.ts`/`types.ts`, ws protocol. Integration points traced to actual source lines. |
| Pitfalls | HIGH | All pitfalls reference specific source files and line ranges. No speculative risks. |

**Overall confidence: HIGH**

### Gaps to Address During Requirements

- **Float-point golden at 10,000 ticks:** Cross-platform (x86/ARM) hash behavior of `sampleLogNormal` not verified beyond 120-tick golden. Phase 1 acceptance gate must include this test. If it diverges, plan the integer-lookup-table mitigation.

- **`slaDeadlineIso` queryability at `PackageDelivered` time:** When the engine schedules `PackageDelivered`, it needs the original `slaDeadlineIso` to compute `onTime`. Clarify during Phase 4 requirements whether (a) the engine retains `slaDeadlineIso` in its in-memory package entity, or (b) the `packageLifecycleReducer` projects it to a queryable table.

- **`PlanSuperseded` vs supersession-aware `PlanAccepted`:** The double-counting pitfall (P7) requires clearing stale `staged` entries when a plan is superseded. The right event-sourced pattern is not yet decided. Surface as a design decision in Phase 3 requirements.

- **Detection scoping benchmark:** The existing detection-cost-scales-with-state tech debt will be exacerbated by continuous induction. The `is_active` filter mitigation needs a Vitest benchmark at 10,000+ package state size to confirm it is sufficient. Add to Phase 3 requirements.

---

## Sources

### Primary (HIGH confidence — codebase reads)

- `packages/simulation/src/engine.ts` (1,267 LOC) — EventQueue, generate() stop condition, 6 seeded substream salts, opt-in feature flags, `pendingBySpoke` manifest pattern
- `packages/simulation/src/rng.ts` — mulberry32 + splitmix32, `makeRng()`, `Rng` interface
- `packages/domain/src/events/schemas.ts` — Zod schemas, `eventSchema` factory, `.strict()` payload contract
- `packages/domain/src/events/domain-event.ts` — closed `DomainEvent` union (22 types as of v1.2+SP2)
- `packages/domain/src/events/contract.assert.ts` — type-equality enforcement (build gate)
- `packages/projections/src/reducers/hub-inventory.ts` — FND-07 bucket logic, `placePackage` null-remove pattern
- `packages/projections/src/reducers/package-location.ts` — FND-05 lifecycle, additive-only upsert, no terminal-state removal
- `packages/projections/src/detector.ts` — `runDetection` without active-package filter (confirmed scaling issue)
- `packages/optimizer/src/rolling/scope.ts` — `detectAffectedScope`, `hubsOf`, `trailersOf`
- `packages/optimizer/src/rolling/types.ts` — `TwinBlock`, `TwinRoute`, `TwinSnapshot`, `EpochResult`
- `packages/optimizer/src/rolling/freeze-idempotency.ts` — `scopeHash`, `canonicalize`, `isFrozen`
- `packages/api/src/sim/driver.ts` — per-tick loop, `runCatchup`, `readAll` usage
- `packages/api/src/ws/snapshots.ts` — `diffTick`, `buildSnapshot`, ws send path
- `.planning/PROJECT.md` — v2.0 goals, constraints, out-of-scope boundaries, v1.0 tech debt
- `milestones/v1.0-MILESTONE-AUDIT.md` — in-memory idempotency debt, utilization proxy debt, detection-cost-scaling debt

### Secondary (MEDIUM confidence — domain and library research)

- npm registry (2026-06-18 verified) — all pinned versions confirmed unchanged
- https://prng.di.unimi.it/ — PRNG quality class reference; confirms mulberry32/splitmix32 approach
- https://gee.cs.oswego.edu/dl/papers/oopsla14.pdf — Fast Splittable PRNGs; confirms XOR-split sub-seeding is sound
- https://domaincentric.net/blog/event-sourcing-snapshotting — Snapshot pattern rationale
- https://dev.to/kspeakman/event-storage-in-postgres-4dk2 — Postgres event store at large scale
- https://eudl.eu/pdf/10.4108/ICST.SIMUTOOLS2009.5603 — DES warm-up; confirms warm-up is a statistical-estimator concern, not a visualization concern
- Locus.sh, TransportGeography.org, ShipScience.com, RedStagFulfillment.com — middle-mile operational patterns (induction scan semantics, last-mile tender handoff, spoke-to-center consolidation flows)

---
*Research completed: 2026-06-23*
*Ready for roadmap: yes*
