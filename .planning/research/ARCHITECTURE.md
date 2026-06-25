# Architecture Research — v2.0 "Complete Simulation Model"

**Domain:** Event-sourced logistics optimization — continuous/open-ended simulation with external induction, outbound delivery, and bidirectional freight
**Researched:** 2026-06-23 (codebase-grounded; full source read of engine, domain events, projections, optimizer contracts)
**Confidence:** HIGH — all integration points traced to actual source lines

---

## Existing Architecture (Authoritative Baseline — Do Not Re-Research)

The shipped system is a pnpm monorepo. The authoritative dependency graph and data flow:

```
@mm/domain          (closed leaf: Zod event union, entities, HOS engine, timing, fuel)
   ├── @mm/event-store     (append-only Postgres, OCC per stream, gap-free global seq)
   ├── @mm/projections     (pure reducers, inline applier, rebuild runner, catch-up)
   ├── @mm/load-planner    (LIFO greedy + local search, independent validator)
   ├── @mm/aggregation     (7-part block key, volume/weight/count)
   ├── @mm/sensor-fusion   (Bayesian zone estimate, wrong-trailer/missed-unload detection)
   ├── @mm/simulation      (seeded DES engine, opt-in feature flags, virtual clock)
   └── @mm/optimizer       (SSP MCF + VRPTW + rolling-horizon epoch, sandboxed twin)

@mm/api             (Fastify 5 + ws — composition root, wires ALL above packages)
@mm/web             (OpenLayers 10 + React 19 + Vite — live USA map, ws client)
```

**Current data flow (one tick):**

```
SimEngine (seeded DES, virtual clock)
  → emit DomainEvent (closed Zod union)
  → appendToStream (Postgres events table, OCC guard)
  → applyInline (pure reducers: packageLocation, trailerState, hubInventory, driverStatus, ...)
  → ws keyframe+delta push (versioned envelope: { v, type, seq, simMs, payload })
  → OpenLayers postrender + vector context (trailer animation along route LineStrings)

  [async / catch-up]
  → geoTrackReducer → GeoKeyframe (trailer position per tick, for map replay)
  → auditTimelineReducer → AuditTimeline (per-package movement history)

  [worker thread, rolling-horizon]
  → runEpoch(events, twinSnapshot) → EpochResult
  → PlanGenerated + PlanAccepted → appendToStream
  → ws recommendations push
```

**Current simulation limits (the 4 gaps v2.0 closes):**

- `durationTicks` is FINITE (~120 ticks = 120 simulated minutes at 1 tick/min). The queue halts when `fireTick > durationTicks`.
- Packages spawn ONLY at the center hub (`hubs[0]`, Memphis). `pendingBySpoke` maps spoke→pending manifest; no spoke-origin queue exists.
- `PackageArrivedAtHub` at the destination spoke is the terminal package state. No "delivered out" event exists.
- The F-07/over-carry path emits one spoke→center `TrailerDeparted` (over-carried package returning), but this is exceptional, not a designed bidirectional flow. No spoke→center freight design exists.

---

## v2.0 Integration Architecture

### Feature Dependency Map

```
CONT-* (Continuous Operation)
  ↓ required by
IND-* (External Induction)      — needs a running sim to receive induction events
  ↓ required by
FLOW-* (Bidirectional Freight)  — spoke-origin packages need both induction AND continuous sim
  ↓ optional dependency
OUT-* (Outbound Delivery)       — terminal handoff event; can land before FLOW-* but most
                                   interesting AFTER FLOW-* (spoke→center consolidation
                                   then center→outbound delivery at destination)
```

**Recommended build order:** CONT-* → IND-* → FLOW-* → OUT-*

CONT-* unblocks everything. IND-* defines the `PackageInducted` event that FLOW-* (spoke-origin packages) reuses. OUT-* adds only a terminal event and is the least coupled.

---

## NEW Domain Events (additions to the closed union in `@mm/domain`)

All new events follow the established pattern: `eventSchema(type, payloadShape)` in `schemas.ts` + matching type alias in `domain-event.ts` + added to `DomainEvent` discriminated union + added to `domainEventSchema` discriminated union. The `contract.assert.ts` type-equality test enforces this mechanically — it will fail the build if the Zod union and the hand-written union diverge.

### 1. `PackageInducted` — NEW (IND-*)

```
PackageInducted {
  packageId: string        // new package entering the network
  inductionHubId: string   // the spoke (or center) where it enters from outside
  destHubId: string        // final destination (may be another spoke, or center)
  sizeClass: SizeClass
  weight: number           // kg
  rfidTagId?: string       // optional, for RFID-enabled induction
  slaDeadlineIso: string   // ISO-8601 delivery deadline (drives priority + optimizer)
  externalOriginRef?: string // opaque external WMS/shipper reference (audit trail)
  occurredAt: string
}
```

**Why this event and not reusing `PackageCreated`:**
`PackageCreated` has `originHubId` but no deadline, no external origin reference, and semantically means "created inside the simulation at the center." `PackageInducted` explicitly models freight entering from OUTSIDE the network (a shipper dropping off at a spoke). Adding `slaDeadlineIso` here avoids a migration of `PackageCreated`. Both events trigger `PackageLocation` and `HubInventory` projection updates; the projections treat them symmetrically (a package exists at a hub). The distinction matters for: (a) the optimizer knowing this is externally-induced freight with a hard deadline, (b) the map showing a "freight appears" animation, (c) KPI tracking of external vs internally-created freight.

**Determinism rule:** `slaDeadlineIso` is derived from `occurredAt` + a deterministic SLA window (`rng.int(windowTicks)` from a NEW seeded substream — see Continuous Operation). `externalOriginRef` is a deterministic ID like `EXT-P00042`. NO wall clock.

### 2. `PackageDelivered` — NEW (OUT-*)

```
PackageDelivered {
  packageId: string
  hubId: string            // the hub the package DEPARTS from (outbound/last-mile handoff)
  deliveryRef: string      // deterministic delivery reference (e.g. "DEL-P00042")
  occurredAt: string
}
```

**Meaning:** The terminal event for a package's lifecycle within the middle-mile network. Freight leaves the destination hub and is handed off to a last-mile carrier or local delivery. This is NOT door-level routing — it is a terminal boundary event. It replaces `PackageArrivedAtHub` as the true end state.

**Effect on `PackageArrivedAtHub`:** This event KEEPS ITS CURRENT MEANING — a package arriving at any intermediate hub (including the destination). `PackageDelivered` is the NEW terminal that fires AFTER `PackageArrivedAtHub` at the final hub (after a simulated last-mile handoff delay). The lifecycle is now:

```
PackageCreated / PackageInducted
  → PackageScanned (inbound)
  → TrailerDeparted (load)
  → PackageScanned (unload)
  → PackageArrivedAtHub (intermediate stop or final hub)
  → [PackageScanned outbound, if consolidation leg follows]
  → [repeat TrailerDeparted / PackageArrivedAtHub for multi-hub routes]
  → PackageDelivered (terminal — leaves the network)
```

### 3. `SpokeFreightCreated` — NEW (FLOW-*)

```
SpokeFreightCreated {
  packageId: string
  originSpokeHubId: string     // spoke where this consolidation freight originates
  destHubId: string            // center hub (consolidation) or another spoke (cross-dock)
  sizeClass: SizeClass
  weight: number
  rfidTagId?: string
  occurredAt: string
}
```

**Why not `PackageCreated`:** `PackageCreated` is semantically center-origin. `SpokeFreightCreated` explicitly models spoke-origin freight for the consolidation flow (spoke→center). The optimizer and projections need to distinguish direction of flow. The sim engine adds a `spokeOutboundPendingBySpoke` map alongside the existing `pendingBySpoke` (center→spoke) for outbound from spokes.

**Alternative considered — extend `PackageCreated` with an `originRole` field:** Rejected. The `PackageCreated` payload is `.strict()` and adding `originRole` would require all existing golden fixtures to include it or the field to be `.optional()`. Making it optional creates an ambiguity (absent = center-origin? or absent = unknown?). A new event is cleaner and keeps `PackageCreated` meaning stable.

### 4. Existing Events — Meaning Unchanged, But New Contexts

| Event | Current Context | New Context in v2.0 |
|-------|----------------|---------------------|
| `PackageCreated` | Center-origin freight | Unchanged. Center-origin only. |
| `PackageArrivedAtHub` | Terminal state (destination spoke) | Now intermediate: fires at EVERY hub including center on consolidation return. No longer terminal. |
| `TrailerDeparted` | Center→spoke only (designed), spoke→center (over-carry only) | Now also spoke→center (designed consolidation leg). The `fromHubId` / `toHubId` fields already support this — no schema change. |
| `PackageScanned` | scanType: inbound/outbound/load/unload | Unchanged. The `outbound` scanType will now also fire at spoke hubs before a consolidation departure. |
| `PackageInducted` | NEW | Replaces external-freight creation |
| `SpokeFreightCreated` | NEW | Spoke-origin freight |
| `PackageDelivered` | NEW | Terminal event, replaces terminal use of `PackageArrivedAtHub` |

**No existing event's `schemaVersion` changes.** All additions are additive new event types in the closed union. The `default: assertNeverEvent(event)` in every existing reducer will correctly reject any new event type that is not yet handled — which means reducers must be updated whenever a new event type is added (the exhaustiveness guard enforces this at build time).

---

## Projection Changes

### Rule: Every reducer has a `default: assertNeverEvent(event)` guard

When a new event type is added to the union, **every reducer's `default` branch fails the build** until the new event is added as a case. This is intentional and correct — it prevents accidental silent no-ops. The pattern for each new event is: add a case to every reducer, either handling it or explicitly no-opping it.

### `packageLocationReducer` (FND-05) — MODIFIED

- `PackageInducted`: place package at `inductionHubId` with `confidence: 1`. Same logic as `PackageArrivedAtHub`.
- `SpokeFreightCreated`: place package at `originSpokeHubId` with `confidence: 1`.
- `PackageDelivered`: REMOVE package from location state entirely (it has left the network). Use `placePackage(state, packageId, null)` — the same pattern `TrailerDeparted` uses for manifested packages.

### `hubInventoryReducer` (FND-07) — MODIFIED

Current buckets: `inbound | outbound | staged`. New behavior:

- `PackageInducted`: place at `inductionHubId` → `inbound` bucket. (Same as `PackageArrivedAtHub`.)
- `SpokeFreightCreated`: place at `originSpokeHubId` → `staged` bucket (it was created at the spoke, physically present, ready for outbound scan). Alternative: `inbound`. Choose `staged` to reflect it is spoke-native, not incoming from another hub.
- `PackageDelivered`: remove from all buckets entirely (`placePackage(state, packageId, null)`).

**New bucket consideration:** Should `HubInventory` gain an `outbound_inducted` or `pending_delivery` bucket? No — the existing `outbound` bucket is semantically "staged at the outbound dock, about to depart," which covers both center→spoke and spoke→center freight. The direction is in the freight's routing metadata (`destHubId`), not in the inventory bucket. Keep the three-bucket model unchanged.

**Bidirectional inventory clarity:** After v2.0, `hubInventory.get(spokeHub).outbound` will contain BOTH: (a) center-created packages that were unloaded and re-staged for a later leg, AND (b) spoke-created freight staged for consolidation. The optimizer distinguishes them by consulting the `packageLocation` + `PackageCreated`/`PackageInducted`/`SpokeFreightCreated` events in the planning twin. The inventory read model intentionally doesn't encode direction — that is projection-layer knowledge.

### `packageLocationReducer` — New Package Lifecycle States

The pre-v2.0 lifecycle had 3 practical states: `at hub (created) → in transit (scan+depart) → arrived (terminal)`. Post-v2.0:

```
pre-induction       [before PackageInducted or SpokeFreightCreated — not yet in system]
at-hub (inducted)   [PackageInducted or SpokeFreightCreated → location at inductionHub]
in-transit          [TrailerDeparted → package is on a trailer]
at-hub (arrived)    [PackageArrivedAtHub → at intermediate or final hub]
delivered-out       [PackageDelivered → removed from location state]
```

The `PackageLocation` row carries `{ packageId, hubId, confidence, lastSeenAt }`. When `PackageDelivered` fires, the row is DELETED from the state (package exits the system). This is a clean, auditable terminal event. The audit timeline (`auditTimelineReducer`) will add a `delivered-out` entry type for the full lineage.

### `trailerStateReducer` (FND-06) — MODIFIED (minor)

No structural change. `TrailerDeparted` with `fromHubId = spokeHub` will naturally update trailer state to `in_transit` with `currentHubId: null` on the consolidation return leg — this already works because `trailerStateReducer` does not hard-code hub roles. The existing no-op cases for new events just need each new type added to the exhaustive switch.

### NEW: `packageLifecycleReducer` (optional read model)

**Recommended addition** for the optimizer and map viz: a per-package state machine projection that explicitly tracks whether a package is `pre-inducted | inducted | in-transit | at-hub | delivered`. This gives the optimizer a single queryable view of "what freight is in the network and where" without reconstructing lifecycle from multiple events. It is a pure reducer added in `@mm/projections` following the existing pattern. Schema table: `package_lifecycle { package_id, state, hub_id | null, last_event_at }`.

### `geoTrackReducer` (catch-up) — MODIFIED

Currently only tracks trailers in transit (keyframes for animation). In v2.0:
- No structural change needed for bidirectional freight — `TrailerDeparted` with spoke origin already works (it has `fromHubId`, `toHubId`, `geometry`). The geo-track reducer uses `RouteRegistered` geometry; spoke→center routes need to be registered at bootstrap.
- `PackageInducted` / `PackageDelivered`: optionally add a "freight appears / freight leaves" overlay point (for map viz, not trailer animation). This can be a new lightweight `FreightFlowKeyframe` table — see Visualization section.

### Golden-Replay Validity

**The determinism constraint is maintained as follows:**

1. All new events use the same `eventSchema` factory with `.strict()` payloads — unknown fields fail at ingestion.
2. All new sim features use OPT-IN feature flags (new seeded substream salts, a 7th substream for IND, an 8th for FLOW/OUT). Feature-OFF produces ZERO new events → the existing golden stream is byte-identical.
3. `PackageArrivedAtHub` KEEPS its schema and meaning. Its role as "terminal" is a sim-level assumption, not encoded in the event's schema. Existing golden streams where `PackageArrivedAtHub` is the last package event remain valid; v2.0 adds `PackageDelivered` AFTER it.
4. The rebuild runner (`rebuildProjections`) replays from `global_seq = 0`. New reducer cases for new event types are additive no-ops on old streams. New event types not present in old streams simply never fire those cases → old golden replays produce the same projection state as before (no new state is created from absent events).

---

## Continuous Operation Architecture (CONT-*)

### The core change: unbounded queue + tick limit removal

The simulation engine's `generate()` function has a hard stop:
```typescript
if (action.fireTick > durationTicks) break;
```

For continuous operation, this guard is removed (or `durationTicks = Infinity`). The engine runs until an external signal (e.g., `AbortController`, process shutdown, or a controlled `stop()` call on the engine). The queue itself is unbounded — `departTrailer` schedules `nextDepart` only if `nextDepart <= durationTicks`, which becomes `schedule(nextDepart, ...)` unconditionally.

**Simulation loop becomes:** `runSimulation` pumps events into the sink in a `for await` loop (already async-safe). The API's sim driver calls `runSimulation` in a background worker thread (`node:worker_threads`, already in use for the optimizer). A graceful shutdown path flushes in-flight events before the process exits.

### Continuous package generation

`createPackageBatch` currently reschedules itself at `nextTick <= durationTicks`. Under continuous operation it reschedules unconditionally. The center continues to create packages every `PACKAGE_INTERVAL_TICKS` ticks indefinitely. NEW: spoke hubs also create packages (see FLOW-*).

### Projection memory bounds

Under continuous operation, the in-memory projection state (`packageLocationState`, `hubInventoryState`, `trailerStateMap`) grows without bound if packages are never removed. The `PackageDelivered` event is the mechanism to purge delivered packages from all projection maps. Without it, a 24-hour run at 1 tick/min × 3 packages/batch × 9 spokes would accumulate ~12,960 package rows — still manageable in RAM. However, for indefinite operation, the `PackageDelivered` purge is architecturally necessary.

For the Postgres-backed projection tables, the `package_location` table grows with delivered packages unless the `applyInline` handler for `PackageDelivered` issues a `DELETE FROM package_location WHERE package_id = $1`. This is the correct pattern — the projection table reflects current live state, not history. History lives in the event log.

### Snapshotting strategy for restart

Today, the optimizer's `(epoch, scopeHash)` idempotency is in-memory only (known debt). For continuous operation across restarts:
- The event log is durable (Postgres). On restart, `rebuildProjections` replays from `global_seq = 0`.
- For very long runs (millions of events), a snapshot table (`projection_snapshots { name, seq, state_json, created_at }`) allows the rebuild runner to load from the latest checkpoint rather than event 0. This is a CONT-* deliverable but low priority for a demo — even a 24h run at 1 tick/min is ~1440 events per sim stream.
- **Recommended approach for v2.0:** Implement the snapshot table schema but only trigger it when `global_seq > SNAPSHOT_THRESHOLD` (e.g., 10,000 events). The rebuild runner checks for a snapshot first, then replays delta from `snapshot.seq`.

---

## Optimizer Awareness Changes (CONT-*/IND-*/FLOW-*/OUT-*)

### Bidirectional demand in the time-expanded graph

The current time-expanded graph has hub nodes + trip edges (center→spoke only, designed). The optimizer's `TwinRoute` has `fromHubId` and `toHubId` — the schema already supports both directions. The key change is:

**NEW: Register spoke→center routes at simulation bootstrap.** The `RouteRegistered` events currently register only center→spoke routes. For bidirectional flow, also register the reverse legs (spoke→center). The `buildRoutes` function in `@mm/simulation/src/network/routes.ts` creates routes for all unique hub pairs — but only the center→spoke direction is used for `TrailerDeparted`. The route IDs (e.g., `route-memphis-atlanta` and `route-atlanta-memphis`) must both be registered and both present in the `TwinSnapshot.routes`.

The time-expanded graph's `buildTimeExpanded` then automatically creates trip edges for spoke→center legs. No graph-shape change is needed — the graph factory is direction-agnostic.

### Outbound deadlines in the optimizer

`PackageInducted` carries `slaDeadlineIso`. The optimizer's `TwinBlock` currently has `{ blockId, nextUnloadHubId, volume }` — no deadline. **Add `deadlineMin?: number` to `TwinBlock`** (OPTIONAL + additive — prior plans reproduce byte-identically). The epoch evaluates SLA urgency via the objective function's `slaPenalty` term.

For the `hubInventoryReducer` to inform the optimizer of consolidation cut times (when the next spoke→center trailer departs), the `TwinTrailer` already carries `departureMin`. The optimizer can compute urgency as `deadlineMin - (departureMin + travelMin)` per block.

### Freeze-window behavior under continuous arrivals

Today the freeze window is `[now, now + freezeWindowMin]` (typically 10–15 minutes). Under continuous arrivals at spoke hubs, the optimizer risks thrashing on newly inducted packages that arrive faster than the rolling-horizon epoch can process them.

**Mitigation:** scope the epoch to hubs with MATERIAL demand changes (new inductions / departures). The `detectAffectedScope` function in `scope.ts` already does this via hub id extraction from events. New events `PackageInducted` and `SpokeFreightCreated` name `inductionHubId` / `originSpokeHubId` — these must be added to `hubsOf(event)` in `scope.ts` so the optimizer reacts to new inductions. The freeze window itself does not change.

**New scope classification in `detectAffectedScope`:**

```typescript
case "PackageInducted":
  return [event.payload.inductionHubId, event.payload.destHubId];
case "SpokeFreightCreated":
  return [event.payload.originSpokeHubId, event.payload.destHubId];
case "PackageDelivered":
  return [event.payload.hubId];  // or [] if delivered packages should not re-scope
```

### Outbound cut-time awareness

For consolidation (spoke→center), the optimizer must know: "what is the next trailer departing this spoke toward the center, and when?" This is already in `TwinTrailer.departureMin`. The new behavior is that `departureMin` now applies to SPOKE-ORIGIN trailers too, not just center-origin. No contract change.

**Consolidation timing constraint:** A spoke-inducted package with `deadlineMin` must be assigned to a trailer departing the spoke with sufficient `travelMin` to reach the center (and any further leg to the destination) before `deadlineMin`. The optimizer's VRPTW time-window constraint models this — the time window on a block is `[0, deadlineMin]`. The existing VRPTW code operates on time windows; adding `deadlineMin` to `TwinBlock` feeds directly into the existing time-window evaluation.

---

## Visualization Changes (OUT-*/IND-*/FLOW-*)

### Freight appearance animation (IND-*)

When `PackageInducted` is pushed via ws, the map shows a "freight appears" pulse at the induction hub. Implementation: a new `{ t: 'freightInducted', hubId, count, simMs }` ws message type. In `@mm/web`, the `inductionLayer` (a new OL VectorLayer) renders a pulsing circle at the hub for 2–3 animation frames, then fades. This is a pure web-side addition — no backend schema change beyond the ws message type.

### Freight departure animation (OUT-*)

When `PackageDelivered` fires, the map shows a "freight exits" animation at the delivery hub. Similar pattern: `{ t: 'freightDelivered', hubId, count, simMs }` ws message. The delivery hub hub icon briefly highlights (color change) then returns to normal.

### Spoke→center consolidation flow (FLOW-*)

Bidirectional trailer animation already works architecturally — `geoTrackReducer` uses `RouteRegistered` geometry and `TrailerDeparted.fromHubId`/`toHubId` to determine which geometry to follow. As long as `route-atlanta-memphis` (the reverse leg) is registered with its geometry, the animation system already handles it. The `postrender` + `getVectorContext` animation loop doesn't care about direction.

**Visual distinction:** To make spoke→center consolidation visually distinct from center→spoke distribution, add a `direction` field to the ws trailer tick payload: `{ ..., direction: 'outbound' | 'inbound' }` (from the spoke's perspective). The map colors consolidation trailers differently (e.g., orange vs blue).

### Hub inventory counts on hover (FND-07 extension)

With induction and delivery, the hub hover panel should show:
- `inbound` count: packages newly arrived from trailers or inducted from outside
- `outbound` count: packages staged for departure (either direction)
- `staged` count: packages being processed
- `delivered_today` count: NEW — packages that received `PackageDelivered` in the last N ticks (a KPI counter on the hub row)

The `delivered_today` counter is a new field in the hub inventory ws push payload. It is NOT stored in the `hub_inventory` projection table (which is current-state only). It is computed from the event log count in a lightweight API query (`SELECT COUNT(*) FROM events WHERE type='PackageDelivered' AND payload->>'hubId'=$1 AND occurred_at > $2`).

---

## Component Boundaries: NEW vs MODIFIED

### @mm/domain — MODIFIED (event union expansion)

| File | Change |
|------|--------|
| `src/events/schemas.ts` | Add `packageInductedSchema`, `packageDeliveredSchema`, `spokeFreightCreatedSchema` |
| `src/events/domain-event.ts` | Add types + union members; update `DomainEvent` union |
| `src/events/contract.assert.ts` | Type-equality test auto-fails until new types are reflected in BOTH union and schema |
| `src/entities/index.ts` | No change — existing entities cover the new events |

### @mm/projections — MODIFIED (reducer + schema)

| File | Change |
|------|--------|
| `src/reducers/package-location.ts` | Handle `PackageInducted`, `SpokeFreightCreated`, `PackageDelivered` |
| `src/reducers/hub-inventory.ts` | Handle `PackageInducted`, `SpokeFreightCreated`, `PackageDelivered` |
| `src/reducers/trailer-state.ts` | Add new events as no-ops (exhaustiveness guard) |
| `src/reducers/audit-timeline.ts` | Add `delivered-out` entry type for `PackageDelivered` |
| `src/reducers/package-lifecycle.ts` | NEW reducer: per-package state machine |
| `src/schema.ts` | Add `PackageLifecycleTable`, update `PROJECTIONS_SCHEMA_SQL` |
| `src/index.ts` | Export new reducer + table types |
| All other reducers | Add new event types as exhaustive no-ops |

### @mm/simulation — MODIFIED (engine + network)

| File | Change |
|------|--------|
| `src/engine.ts` | Remove `durationTicks` hard stop; add continuous loop; add `IND_RNG_SALT` / `FLOW_RNG_SALT`; add `spokeOutboundPending` map; add `inductionEnabled?` + `consolidationEnabled?` + `outboundDeliveryEnabled?` opt-in flags; emit new events |
| `src/network/routes.ts` | Register both-direction routes (spoke→center in addition to center→spoke) |
| `src/index.ts` | Export new salt constants + option types |

**New sim feature flags (determinism-safe, OPT-IN):**

```typescript
interface SimulateOptions {
  // ... existing flags ...
  readonly inductionEnabled?: boolean;        // IND-* — NEW seeded substream
  readonly consolidationEnabled?: boolean;    // FLOW-* — NEW seeded substream
  readonly outboundDeliveryEnabled?: boolean; // OUT-* — NEW seeded substream
  // continuous: durationTicks becomes optional (Infinity when absent)
}
```

Each flag: absent or false → ZERO new events → golden byte-identical.

### @mm/optimizer — MODIFIED (scope + twin types)

| File | Change |
|------|--------|
| `src/rolling/scope.ts` | Add `PackageInducted`, `SpokeFreightCreated`, `PackageDelivered` to `hubsOf()` and `trailersOf()` |
| `src/rolling/types.ts` | Add `deadlineMin?: number` to `TwinBlock` (optional, additive) |
| `src/rolling/twin.ts` | Build `TwinBlock.deadlineMin` from `packageLifecycle` projection when available |
| All `switch` on `DomainEvent` | Add new event types as exhaustive no-ops |

### @mm/api — MODIFIED (ws push, new message types)

| File | Change |
|------|--------|
| `src/ws/` | Add `freightInducted` and `freightDelivered` message types to ws protocol |
| `src/sim-driver.ts` | Pass new opt-in flags; route new events to ws push |
| `src/projections-runner.ts` | Wire new `packageLifecycleReducer` |

### @mm/web — MODIFIED (map viz)

| File | Change |
|------|--------|
| `src/map/layers/` | Add `inductionLayer` (pulsing circle on PackageInducted) |
| `src/map/layers/` | Add `deliveryLayer` (hub highlight on PackageDelivered) |
| `src/map/wsClient.ts` | Handle new `freightInducted`, `freightDelivered` message types |
| Trailer animation | Add `direction` field to distinguish consolidation vs distribution trailers visually |

---

## Data Flow: Bidirectional Freight End-to-End

```
Sim (spoke Atlanta, consolidation enabled)
  → SpokeFreightCreated { packageId: P-ATL-001, originSpokeHubId: atlanta, destHubId: memphis }
  → appendToStream("package-P-ATL-001")
  → hubInventoryReducer: atlanta.staged += P-ATL-001
  → packageLifecycleReducer: P-ATL-001 → "at-hub"
  → ws push: hubInventory delta (atlanta staged count +1)

[Next spoke→center departure tick]
  → PackageScanned { packageId: P-ATL-001, hubId: atlanta, scanType: "outbound" }
  → hubInventoryReducer: atlanta.staged → atlanta.outbound
  → PackageScanned { scanType: "load" }
  → hubInventoryReducer: remove from atlanta entirely
  → TrailerDeparted { trailerId: T002, fromHubId: atlanta, toHubId: memphis, ... }
  → trailerStateReducer: T002 → in_transit, currentHubId: null
  → geoTrackReducer: start keyframe on route-atlanta-memphis geometry
  → ws push: trailer tick (T002, direction: "consolidation")
  → detectAffectedScope → scope includes atlanta + memphis
  → runEpoch → TwinBlock { blockId: B-ATL-001, nextUnloadHubId: memphis, deadlineMin: ... }

[Arrival at center Memphis]
  → TrailerArrivedAtHub { trailerId: T002, hubId: memphis }
  → TrailerDocked { trailerId: T002, hubId: memphis }
  → PackageScanned { packageId: P-ATL-001, hubId: memphis, scanType: "unload" }
  → PackageArrivedAtHub { packageId: P-ATL-001, hubId: memphis }
  → hubInventoryReducer: memphis.inbound += P-ATL-001
  → packageLifecycleReducer: P-ATL-001 → "at-hub"

[Outbound delivery (out-enabled)]
  → PackageScanned { packageId: P-ATL-001, hubId: memphis, scanType: "outbound" }
  → PackageDelivered { packageId: P-ATL-001, hubId: memphis, deliveryRef: "DEL-P-ATL-001" }
  → packageLocationReducer: remove P-ATL-001
  → hubInventoryReducer: remove from memphis.outbound
  → packageLifecycleReducer: P-ATL-001 → "delivered"
  → ws push: freightDelivered { hubId: memphis, count: 1 }
  → map: memphis hub icon flashes "delivered" highlight
```

---

## Continuous-Run Memory and Projection Bounds

| Concern | v1.x behavior | v2.0 behavior |
|---------|---------------|---------------|
| `packageLocationState` (in-memory Map) | Grows to ~max concurrent packages (small run: ~100) | Bounded by `PackageDelivered` purges. Without delivery: grows indefinitely. With delivery: stable at ~(packages in flight at any time). |
| `hubInventoryState` (in-memory Map) | One entry per hub (fixed: 10 hubs) | Unchanged — fixed hub count, per-hub sets sized by packages in transit |
| `trailerStateMap` | One entry per trailer (fixed fleet) | Unchanged — fleet is fixed size |
| `geoTrackState` | One keyframe set per active leg | One keyframe set per active leg; closed on `TrailerArrivedAtHub`. Bounded. |
| Postgres `events` table | ~1000 events per 120-tick run | Unbounded growth. Normal for an event store — the log IS the truth. Index on `global_seq` and `stream_id` already handles large table queries. |
| Postgres `package_location` table | Grows with all-ever-created packages | With `DELETE on PackageDelivered`: bounded to current live packages only |
| Postgres `hub_inventory` table | 10 rows (one per hub), small JSONB arrays | Bounded — same shape, potentially larger arrays per hub, bounded by delivery purges |
| Optimizer `(epoch, scopeHash)` in-memory idempotency | Grows without restart (known debt) | Add TTL eviction: discard entries where `epoch.nowMin < nowMin - EPOCH_RETENTION_MIN` (e.g., 60 minutes). This bounds the idempotency map at ~4 entries per active scope per retention window. |

### Snapshot / Checkpoint Protocol

For resilience across process restarts under continuous operation:

```
projection_checkpoints {
  name: string          -- projection name (e.g. "package_location")
  last_seq: bigint      -- last applied global_seq
  state_blob: bytea     -- JSON-serialized state (or NULL for DB-backed projections)
  updated_at: timestamp
}
```

Frequency: checkpoint every N events (e.g., 1000) or every T seconds (e.g., 60s). On restart: load checkpoint, then replay from `last_seq + 1`. This bounds rebuild cost to O(events since last checkpoint) rather than O(all events).

For DB-backed projections (projection tables are the state), `last_seq` alone is sufficient — no blob needed. The state is in the projection table; just re-run `applyInline` from the checkpoint seq.

---

## Suggested Build Order with Dependencies

### Phase 1: CONT-* — Continuous Operation Foundation

**Scope:** Remove the finite tick limit in `generate()`; make the sim loop continuous; register both-direction routes at bootstrap; add projection memory-bounds guards (`PackageDelivered` purge path is stubbed but not wired to sim yet).

**Why first:** Every other feature depends on a running sim. This is also the lowest domain complexity — it is a control-flow change, not a new event type.

**NEW components:** None
**MODIFIED components:** `@mm/simulation/src/engine.ts` (queue loop), `@mm/simulation/src/network/routes.ts` (bidirectional registration), `@mm/api/src/sim-driver.ts` (graceful shutdown path)

**Determinism gate:** With `durationTicks` = current finite value, output is byte-identical. Continuous mode is triggered by a NEW `continuous: true` option, which is OPT-IN.

### Phase 2: IND-* — External Induction

**Scope:** Add `PackageInducted` to the domain event union. Sim emits it at spoke hubs (opt-in `inductionEnabled`). Update all reducers. Add `PackageInducted` to `detectAffectedScope` in the optimizer. Add `freightInducted` ws message + map pulse animation.

**Depends on:** Phase 1 (continuous sim to have meaningful induction volume)
**NEW events:** `PackageInducted`
**NEW components:** `inductionLayer` in `@mm/web`
**MODIFIED components:** `@mm/domain` (union), `@mm/projections` (all reducers), `@mm/optimizer/src/rolling/scope.ts`, `@mm/api` (ws push), `@mm/web` (ws client + layer)

### Phase 3: FLOW-* — Bidirectional Freight / Spoke→Center Consolidation

**Scope:** Add `SpokeFreightCreated`. Sim emits it at spoke hubs (opt-in `consolidationEnabled`). Spoke-outbound pending manifest. Spoke→center `TrailerDeparted` (designed, not over-carry). Update reducers. Optimizer sees both directions. Map shows consolidation trailers with distinct direction color.

**Depends on:** Phase 2 (IND-* defines the induction pattern; bidirectional routes registered in Phase 1)
**NEW events:** `SpokeFreightCreated`
**NEW components:** Spoke-outbound manifest in sim engine; direction field in ws trailer tick
**MODIFIED components:** All reducers (new event type cases), optimizer scope, map animation (direction-aware coloring)

### Phase 4: OUT-* — Outbound Delivery

**Scope:** Add `PackageDelivered`. Sim emits it at destination hubs after a deterministic post-arrival delay (opt-in `outboundDeliveryEnabled`). Update reducers (DELETE from package_location, hub_inventory on delivered). Add `freightDelivered` ws message + hub highlight animation. Wire projection memory purge fully.

**Depends on:** Phase 1 (continuous sim for delivery to be observable), Phase 2+3 (more interesting with inducted and consolidated freight completing the cycle). Can technically land before FLOW-* but is most visible after.
**NEW events:** `PackageDelivered`
**NEW components:** `deliveryLayer` in `@mm/web`; snapshot/checkpoint schema (projection_checkpoints)
**MODIFIED components:** All reducers (purge path), `@mm/projections/src/schema.ts` (new table), `@mm/api` (ws push)

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Making `PackageArrivedAtHub` terminal by convention

**What goes wrong:** Treating `PackageArrivedAtHub` at the destination spoke as "done" throughout the codebase (projections, optimizer, viz) means adding `PackageDelivered` requires finding and updating every place that makes this assumption.
**Prevention:** In v2.0, `PackageArrivedAtHub` means "arrived at a hub" (always has). Treat delivered state as EXPLICITLY the `PackageDelivered` event. Update the `packageLocationReducer` FIRST so the build fails immediately if anything downstream relies on `PackageArrivedAtHub` as terminal.

### Anti-Pattern 2: Encoding freight direction in the event schema

**What goes wrong:** Adding `direction: 'center-to-spoke' | 'spoke-to-center'` to `TrailerDeparted` schema means old events are incompatible without migration.
**Prevention:** Direction is INFERABLE from `fromHubId`/`toHubId` + the hub network (center is `hubs[0]`). Keep `TrailerDeparted` schema unchanged. The optimizer and map derive direction from the payload fields, not from a new enum.

### Anti-Pattern 3: A new `inductionRng` draw that perturbs `rng`

**What goes wrong:** Adding induction randomness to the main `rng` substream changes the sequence for all subsequent draws → golden stream no longer byte-identical even with `inductionEnabled: false`.
**Prevention:** A DISTINCT `inductionRng = makeRng((seed ^ IND_RNG_SALT) >>> 0)`, constructed ONLY when `inductionEnabled`. Salt must be asserted pairwise-distinct from all 6 existing salts in the salt-collision test.

### Anti-Pattern 4: Projection memory growth without the `PackageDelivered` purge

**What goes wrong:** Under continuous operation, `package_location`, `hub_inventory`, and in-memory reducer maps grow without bound because no event removes delivered packages.
**Prevention:** `PackageDelivered` is the bounded-memory mechanism. It MUST fire for every package that leaves the network. The sim engine's outbound delivery handler is responsible for emitting it. The `packageLocationReducer` must `DELETE` (null-place) on this event. This is enforced by the exhaustiveness guard — the build fails if any reducer doesn't handle `PackageDelivered`.

### Anti-Pattern 5: Registering only one-direction routes

**What goes wrong:** If only center→spoke routes are registered via `RouteRegistered`, the optimizer's time-expanded graph has no spoke→center trip edges. Consolidation trailers appear as `TrailerDeparted` events with a `fromHubId` that has no matching route in the optimizer → consolidation legs are invisible to the optimizer.
**Prevention:** Bootstrap must emit `RouteRegistered` for BOTH directions. `buildRoutes` in `routes.ts` should be updated to generate both-direction routes. The ORS geometry for spoke→center is the REVERSE of center→spoke (same polyline, reversed coordinate array) — no new ORS call needed.

---

## Sources

- `packages/domain/src/events/domain-event.ts` — closed DomainEvent union (22 types as of v1.2+SP2)
- `packages/domain/src/events/schemas.ts` — Zod schemas, `eventSchema` factory, `.strict()` payload contract
- `packages/domain/src/events/contract.assert.ts` — type-equality enforcement (build gate)
- `packages/projections/src/reducers/hub-inventory.ts` — FND-07 bucket logic + `placePackage` null-remove pattern
- `packages/projections/src/reducers/package-location.ts` — FND-05 lifecycle + `DIRECT_SCAN_CONFIDENCE`
- `packages/projections/src/reducers/trailer-state.ts` — FND-06 status machine, direction-agnostic
- `packages/optimizer/src/rolling/scope.ts` — `detectAffectedScope`, `hubsOf`, `trailersOf` exhaustive switch
- `packages/optimizer/src/rolling/types.ts` — `TwinBlock`, `TwinRoute`, `TwinSnapshot`, `EpochResult` contracts
- `packages/optimizer/src/rolling/epoch.ts` — `buildTravelModel`, both-direction symmetric oracle
- `packages/simulation/src/engine.ts` — generate(), durationTicks guard, 6 seeded substreams, opt-in feature flags, `pendingBySpoke` pattern (model for `spokeOutboundPending`)
- `packages/simulation/src/network/routes.ts` — `buildRoutes`, `buildTransitParamsByLeg`, directed routeId convention

---
*Architecture research for: Middle-Mile Trailer Optimization Platform v2.0 (Complete Simulation Model)*
*Researched: 2026-06-23*
*Based on: full codebase read — engine.ts (1267 lines), schemas.ts, domain-event.ts, hub-inventory.ts, package-location.ts, trailer-state.ts, scope.ts, rolling/types.ts, epoch.ts (partial), projections/index.ts, projections/schema.ts*
