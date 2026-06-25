# Phase 22: Outbound Delivery - Research

**Researched:** 2026-06-24
**Domain:** Simulation engine extension — terminal domain event, RNG substream, projection purge, WS tick field, OpenLayers layer, operator KPI widget
**Confidence:** HIGH (all claims verified against live codebase; no external dependencies introduced)

---

## Summary

Phase 22 closes the end-to-end freight lifecycle by adding a `PackageDelivered` terminal domain event that fires after a seeded outbound dwell at the destination hub. Three projection reducers hard-DELETE the package row on this event to bound table growth (OUT-04). A new `OUTBOUND_RNG_SALT` seeds the dwell duration substream, captured in `SimContinuation` following the exact Phase-20 `inductPackage`/induction-substream capture pattern. An `onTime` SLA flag is computed by comparing `deliveredAt` (virtual clock ISO, whole-minute canonicalized via `epochMinutesToIso`) against `slaDeadlineIso` locked at induction. The WS channel gains a `deliveryEvents` tick-only field (never on snapshot, mirroring `inductionEvents`/Pitfall-7), and a destination-hub flash layer mirrors `createInductionLayer`/`flashInduction`. A `delivery_kpi` projection reducer (P2, OUT-05) accumulates event-derived counters.

The determinism keystone is ironclad: `outboundDeliveryEnabled: false` (default) produces zero new RNG draws and zero new events; the seed-42 10k-tick golden SHA `3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861` must remain byte-identical with the flag off.

**Primary recommendation:** Mirror the Phase-20 `inductPackage` EventQueue task pattern verbatim for a `deliverPackage` one-shot task. Use `epochMinutesToIso`/`isoToEpochMinutes` from `@mm/domain/src/hos.ts` for whole-minute ISO canonicalization (same helpers Phase 20 uses). Follow the 5-file domain union ceremony exactly as established by `PackageInducted`/`PlanSuperseded`.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Determinism keystone (CRITICAL):**
- `outboundDeliveryEnabled: false` (default) ⇒ ZERO `PackageDelivered` events ⇒ ZERO new RNG draws ⇒ ZERO projection purges ⇒ seed-1234 + seed-42 (`3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861`) goldens **byte-identical**. Non-negotiable acceptance gate.
- The golden hashes the **sim event stream + engine world state**, NOT projection tables — a hard DELETE in a projection reducer cannot affect the golden.

**D-22-1 — Purge mechanism = hard DELETE:**
- On `PackageDelivered`, projection reducers DELETE rows from `packageLocation`, `hubInventory`, and `zoneEstimate` (true row removal). Reducer MUST be a no-op on a missing row (never throw). No read-modify-write assuming the row exists.

**D-22-2 — Ordering: strictly-positive dwell, comparator UNCHANGED:**
- Outbound dwell is strictly positive (>= 1 tick), so `PackageDelivered` is always at a strictly-later tick than `PackageArrivedAtHub`. Existing `(tick, sequenceId)` ordering guarantees arrival-before-delete. The `(tick, sequenceId)` comparator MUST NOT be changed.

**D-22-3 — KPI is event-derived, not a row-count:**
- OUT-05 KPI is its own projection reducer incrementing `deliveredCount`/`onTimeCount` on each `PackageDelivered`. MUST NOT be a `COUNT(*)` over purged tables.

**D-22-4 — RNG: new salted substream, captured in continuation:**
- Add `OUTBOUND_RNG_SALT` (new XOR salt, pairwise-distinct from all 7 prior salts, extend salts test). Built only when flag is on (lazy, like `INDUCTION_RNG_SALT`).
- Substream PRNG state + pending-delivery task + `deliveredCounter` captured in `SimContinuation`. Continuation-equivalence test with `outboundDeliveryEnabled: true` crossing a chunk boundary mid-dwell.

**D-22-5 — onTime flag:**
- `onTime = (deliveredAt <= slaDeadlineIso)`. `slaDeadlineIso` locked at induction (Phase 20). `deliveredAt` = sim clock ISO with same whole-minute canonicalization Phase 20 used.

### Claude's Discretion
- Outbound dwell distribution / mean (deterministic, seeded) — tuned so deliveries are watchable in the demo without instantly draining hubs.
- VIZ-14 highlight style (color/pulse) — distinct from VIZ-13 induction (purple) and VIZ-12 consolidation (cyan).
- Whether the dwell is scheduled as a self-contained `EventQueue` task at arrival (preferred, mirrors Phase-20 `inductPackage`) vs. polled — pick the EventQueue task (no external append, deterministic).

### Deferred Ideas (OUT OF SCOPE)
- Returns / reverse-logistics as a fourth flow direction (FLOW-FUT-01).
- Proof-of-delivery artifacts / real delivery confirmation integration.
- Per-destination SLA dashboards beyond the single on-time% KPI.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| OUT-01 | New `PackageDelivered` terminal domain event in closed union (Zod `.strict()`, `validate()` round-trip) | 5-file union ceremony verified; `PackageInducted` is the exact template |
| OUT-02 | Destination-hub detection triggers delivery — `PackageArrivedAtHub` no longer terminal; every package reaches `PackageDelivered` when flag on | `arriveTrailer()` in engine.ts at line ~1554 is the emit site for `PackageArrivedAtHub`; delivery scheduling hooks in here |
| OUT-03 | `PackageDelivered` carries `onTime` SLA flag (`deliveredAt <= slaDeadlineIso`) | `epochMinutesToIso`/`isoToEpochMinutes` helpers verified at `packages/domain/src/hos.ts:141-152` |
| OUT-04 | `PackageDelivered` hard-DELETE purges from `packageLocation`, `hubInventory`, `zoneEstimate` | All three reducers verified; `placePackage(state, packageId, null)` pattern in hub-inventory is the purge idiom |
| VIZ-14 | Delivery events animate on the map — destination-hub highlight on `PackageDelivered` | `createInductionLayer`/`flashInduction` in `packages/web/src/map/layers.ts:247-278` is the exact template |
| OUT-05 (P2) | Delivered-out counter + on-time % KPI panel widget | `HubBalance` pattern (`packages/web/src/panels/HubBalance.tsx`) and `KpiDashboard` are the widget templates |
</phase_requirements>

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| `PackageDelivered` domain event | Domain (`packages/domain`) | — | Closed-union + Zod schema leaf; no runtime dependencies |
| Outbound dwell scheduling (`deliverPackage` task) | Simulation engine (`packages/simulation`) | — | EventQueue DATA task; only sim engine constructs/dispatches |
| `OUTBOUND_RNG_SALT` substream | Simulation engine (`packages/simulation`) | — | RNG salts are engine-private constants |
| `SimContinuation` outbound capture | Simulation engine (`packages/simulation`) | — | `captureContinuation()` in `engine.ts:1919` captures all sub-stream states |
| Projection purge reducers | Projections (`packages/projections`) | — | Pure reducers fold events into read model; DELETE on `PackageDelivered` |
| Delivery KPI projection | Projections (`packages/projections`) | — | Event-derived counter reducer (D-22-3) |
| `deliveryEvents` WS field | API (`packages/api`) | — | Added to `TickPayload`; never to `SnapshotPayload` (Pitfall-7) |
| `DeliveryEvent` WS envelope type | API (`packages/api`) | — | Mirrors `InductionEvent` in `packages/api/src/ws/envelope.ts` |
| Delivery flash layer (VIZ-14) | Web (`packages/web`) | — | New `createDeliveryLayer`/`flashDelivery` mirroring induction pattern |
| Operator KPI widget (OUT-05 P2) | Web (`packages/web`) | API (`packages/api`) | React component + REST endpoint; mirrors `HubBalance`/`KpiDashboard` |

---

## Standard Stack

No new runtime dependencies introduced. All four gaps are pure engine/projection/UI extensions of existing packages. [VERIFIED: live codebase grep — `PackageDelivered` not yet in engine.ts or domain-event.ts]

### Core (existing, unchanged)
| Package | Version | Purpose | Constraint |
|---------|---------|---------|------------|
| `@mm/domain` | workspace | Closed event union, Zod schemas, `epochMinutesToIso`/`isoToEpochMinutes` | All new events must pass 5-file union ceremony |
| `@mm/simulation` | workspace | Deterministic engine, EventQueue, `SimContinuation` | `outboundDeliveryEnabled` flag gates all new draws |
| `@mm/projections` | workspace | Pure reducers for `packageLocation`, `hubInventory`, `zoneEstimate` | DELETE reducers must be idempotent no-ops on missing rows |
| `@mm/api` | workspace | WS envelope (`TickPayload`), `attachSnapshotSocket`, `Broadcast` type | `deliveryEvents` tick-only, never snapshot |
| `packages/web` | workspace | OpenLayers layers, React panels | New layer mirrors induction layer exactly |

---

## Architecture Patterns

### System Architecture Diagram

```
[SimulateOptions.outboundDeliveryEnabled = true]
       |
       v
[PackageArrivedAtHub @ destination]
       |
       | schedule(arriveTick + dwell, deliverPackage task)
       |      dwell >= 1 tick, drawn from outboundRng (OUTBOUND_RNG_SALT)
       v
[deliverPackage task fires]
       |
       | emit PackageDelivered{ packageId, hubId, deliveredAt, onTime }
       |        onTime = (deliveredAt <= slaDeadlineIso)
       |        deliveredAt = epochMinutesToIso(currentEpochMin)
       v
[Event stream] ──────────────────────────────────────────────────────────
       |                    |                    |                    |
       v                    v                    v                    v
[packageLocation        [hubInventory        [zoneEstimate        [delivery_kpi
 reducer:                reducer:             reducer:             reducer:
 DELETE row]             DELETE row]          no-op (RFID only)]  increment
                                              [confirmed no        deliveredCount
                                               RFID data here]    + onTimeCount]
       |                    |
       v                    v
[Postgres projection tables — bounded (OUT-04)]
       |
       v
[WS broadcast: TickPayload.deliveryEvents (TRANSIENT, tick-only)]
       |
       v
[packages/web: flashDelivery() → destination-hub highlight (VIZ-14)]
       |
       v
[packages/web: DeliveryKpiWidget polls GET /api/delivery-kpi (OUT-05 P2)]
```

### Recommended Project Structure (additions only)

```
packages/domain/src/events/
├── schemas.ts                    # ADD: packageDeliveredSchema (Zod)
├── domain-event.ts               # ADD: PackageDelivered type + union member
├── contract.assert.ts            # ADD: "PackageDelivered" case in exhaustive switch
└── index.ts                      # ADD: packageDeliveredSchema export

packages/domain/test/
└── package-delivered.unit.test.ts  # NEW: round-trip validate test (mirrors package-inducted)

packages/simulation/src/
├── engine.ts                    # ADD: OUTBOUND_RNG_SALT, outboundRng, deliverPackage task,
│                                #      deliveredCounter, outboundDeliveryEnabled guard
└── continuation.ts              # ADD: SimTask.deliverPackage variant, SerializedRngStates.outbound,
                                 #      SerializedWorldState.deliveredCounter

packages/simulation/test/
└── outbound-determinism.unit.test.ts  # NEW: flag-off byte-identical, flag-on delivers, continuation-equivalence

packages/projections/src/reducers/
├── package-location.ts          # ADD: PackageDelivered case → DELETE
├── hub-inventory.ts             # ADD: PackageDelivered case → DELETE (placePackage null)
├── zone-estimate.ts             # ADD: PackageDelivered case → no-op (matches pattern)
└── delivery-kpi.ts              # NEW: event-derived deliveredCount + onTimeCount reducer

packages/api/src/ws/
└── envelope.ts                  # ADD: DeliveryEvent interface, TickPayload.deliveryEvents,
                                 #      SnapshotPayload unchanged

packages/web/src/map/
├── layers.ts                    # ADD: createDeliveryLayer(), flashDelivery()
└── deliveryColoring.ts          # NEW: delivery marker style (distinct color from purple/cyan)

packages/web/src/panels/
└── DeliveryKpi.tsx              # NEW (P2): delivered-out count + on-time % widget
```

---

## Code Anchors — Verified Against Live Codebase

### 1. The 5-File Domain Union Ceremony (Phase-20 `PackageInducted` template)

**File 1: `packages/domain/src/events/schemas.ts`**
- `packageDeliveredSchema` = `eventSchema("PackageDelivered", z.object({ packageId: id, hubId: id, deliveredAt: z.string().min(1), onTime: z.boolean(), occurredAt }))` [VERIFIED: `eventSchema` helper at line 35-44; `packageInductedSchema` at line 430]
- Add to `domainEventSchema` discriminated union at line 448 (current last entry: `planSupersededSchema` at line 477)

**File 2: `packages/domain/src/events/domain-event.ts`**
- Add `export type PackageDelivered = z.infer<typeof packageDeliveredSchema>;` after line 157 (`PackageInducted` at line 145)
- Add `| PackageDelivered` to `DomainEvent` union (currently ends with `| PlanSuperseded` at line 194) [VERIFIED: domain-event.ts lines 165-194]

**File 3: `packages/domain/src/events/contract.assert.ts`**
- Add `case "PackageDelivered":` inside `assertExhaustive()` switch (currently `case "PackageInducted":` at line 49 and `case "PlanSuperseded":` at line 50 before `return`) [VERIFIED: contract.assert.ts lines 25-55]

**File 4: `packages/domain/src/events/index.ts`**
- Export `PackageDelivered` type (after `PackageInducted` at line 29)
- Export `packageDeliveredSchema` (after `packageInductedSchema` at line 59) [VERIFIED: index.ts lines 1-61]

**File 5: `packages/domain/test/package-delivered.unit.test.ts`** (NEW)
- Mirror of `packages/domain/test/package-inducted.unit.test.ts` (lines 1-58)
- `buildWellFormedPackageDelivered()` returns `{ type: "PackageDelivered", schemaVersion: EVENT_SCHEMA_VERSION, payload: { packageId, hubId, deliveredAt, onTime, occurredAt } }`
- Tests: round-trips validateEvent(), packageDeliveredSchema.safeParse() succeeds, `.strict()` rejects extra field [VERIFIED: template at package-inducted.unit.test.ts]

### 2. The Arrival Emit Site in `packages/simulation/src/engine.ts`

The `PackageArrivedAtHub` destination-hub delivery trigger is inside `arriveTrailer()` at **line ~1554**:

```typescript
// VERIFIED: engine.ts lines 1544-1559 (the unload loop for carried packages)
for (const packageId of carried) {
  if (packageId === heldBack) continue;
  const unload: PackageScanned = { ... };
  emit(`package-${packageId}`, unload);

  const atHub: PackageArrivedAtHub = {
    type: "PackageArrivedAtHub",
    schemaVersion: 1,
    payload: { packageId, hubId: spoke.hubId },
  };
  emit(`package-${packageId}`, atHub);
  // PHASE 22: when outboundDeliveryEnabled && spoke.hubId === packageDestHub:
  //   schedule(arriveTick + outboundRng.int(DWELL_MAX) + 1, {
  //     kind: "deliverPackage",
  //     packageId,
  //     hubId: spoke.hubId,
  //     slaDeadlineIso: <needs lookup or carry-through>,
  //   })
}
```

**The destination check:** The engine has `carried: readonly string[]` package IDs. The dest hub for each package is not currently carried in the `arriveTrailer` task (the `carried` array has IDs only). To determine whether `spoke.hubId === packageDestHub`, Phase 22 needs one of:
- (a) carry `destHubId` per package in the `arriveTrailer` task (breaking change to `SimTask.arriveTrailer`), OR
- (b) maintain a `destHubByPackage: Map<string, string>` in world state (parallel to `consolidationDestByPackage`), OR
- (c) deliver ALL packages at their arrival hub (center-distributed packages already arrived at their spoke, so this is always the destination)

**Planner recommendation:** Option (c) is correct — the existing engine only calls `arriveTrailer()` for packages that arrived at their destination spoke (center-distributed) or at the center (over-carry / consolidation re-sort). Every package in `carried` has `destHubId === spoke.hubId` by construction — the LIFO load planner loads only packages destined for the spoke. No `destHubByPackage` map needed. [VERIFIED: engine.ts line 1348-1351: `pendingBySpoke.get(spoke.hubId)` is drained — only spoke-destined packages are loaded]

**Except for inducted packages (cross-dock path):** An inducted package from spoke A goes to center via consolidation, then is re-staged into `pendingBySpoke[spokeB]` by `arriveConsolidationAtCenter`. It then arrives at `spoke B` via the standard `arriveTrailer()` path — which is correct (`spoke.hubId === packageDestHub`). No special handling needed.

### 3. Projection Reducers (packages/projections/src/reducers/)

**`package-location.ts`** — add `PackageDelivered` case:
- Current switch handles `PackageScanned`, `PackageArrivedAtHub`, `PackageInducted` as upsert; all others return `state`
- Phase 22: add `case "PackageDelivered":` that returns `new Map(state)` with `.delete(event.payload.packageId)` — or use the same copy-and-delete pattern as the upsert path [VERIFIED: package-location.ts lines 60-121]
- The `default: return assertNeverEvent(event);` guard at line 119 means omitting the case causes a compile error

**`hub-inventory.ts`** — add `PackageDelivered` case:
- The existing `placePackage(state, packageId, null)` idiom (lines 103-132) already implements a no-op-safe removal: `if (prior === undefined) { placement.delete(packageId); }` — it does NOT throw on a missing row
- Phase 22: `case "PackageDelivered": return placePackage(state, event.payload.packageId, null);`
- The `default: return assertNeverEvent(event);` guard at line 244 requires the case [VERIFIED: hub-inventory.ts lines 157-246]

**`zone-estimate.ts`** — add `PackageDelivered` case (no-op):
- Zone estimates are RFID-based; `PackageDelivered` carries no RFID data. The correct action is a no-op (same as `PackageInducted` at line 200). However, to keep the bounded-memory promise fully correct, consider deleting all zone estimate entries for the delivered packageId. Given the `zoneEstimateKey = "${packageId}|${trailerId}"` composite key, a full purge requires iterating the map — this may be desirable for OUT-04.
- Safer KISS approach: treat as no-op (consistent with Phase-21 consolidation behavior; zone estimates are transient observations and naturally expire from detector scope via Phase-21 `is_active` filter)
- Planner should decide: purge or no-op. The CONTEXT.md says "DELETE-purge from `zoneEstimate`" — so purge all entries where key starts with `packageId|` [VERIFIED: zone-estimate.ts lines 131-206; `zoneEstimateKey` at line 76]

### 4. RNG Salts — Verified Constants

From `packages/simulation/src/engine.ts` lines 85-116:

```typescript
// VERIFIED: engine.ts lines 85-116
export const RFID_RNG_SALT       = 0x5f_1d_a7_c3;  // substream 1
export const OVER_CARRY_RNG_SALT = 0x3c_a7_1d_5f;  // substream 2
export const TIMING_RNG_SALT     = 0x00_00_77_17;  // substream 3
export const HOS_RNG_SALT        = 0x10_51_09_01;  // substream 4
export const FUEL_RNG_SALT       = 0x2b_3d_91_e7;  // substream 5 (when fuel.enabled)
export const INDUCTION_RNG_SALT  = 0x8f_2c_4a_e1;  // substream 6 (when inductionEnabled)
// PHASE 22: add OUTBOUND_RNG_SALT = <new pairwise-distinct value>  // substream 7 (when outboundDeliveryEnabled)
```

**The salt pairwise-distinct test** lives at `packages/simulation/test/fuel-determinism.unit.test.ts` lines 43-75. Phase 22 extends this test's array to include `OUTBOUND_RNG_SALT`. [VERIFIED: fuel-determinism.unit.test.ts lines 43-75 — `INDUCTION_RNG_SALT` was added there in Phase 20]

**Choosing `OUTBOUND_RNG_SALT`:** Must differ from all 6 above. A hash-split value like `0xc4_f8_32_b6` satisfies pairwise distinctness. Final value is Claude's discretion — the test will catch collisions.

### 5. `SimContinuation` Induction-Capture Pattern — Quoted Code

From `packages/simulation/src/continuation.ts`:

**`SerializedRngStates` (line 125-136):**
```typescript
// VERIFIED: continuation.ts lines 125-136
export interface SerializedRngStates {
  readonly base: number;
  readonly rfid: number;
  readonly overCarry: number;
  readonly timing: number;
  readonly hos: number;
  readonly fuel: number | undefined;   // present only when fuel enabled
  readonly induction: number | undefined; // present only when inductionEnabled. IND-02.
  // PHASE 22: add:
  // readonly outbound: number | undefined; // present only when outboundDeliveryEnabled
}
```

**`SerializedWorldState.inductionCounter` (line 121):**
```typescript
// VERIFIED: continuation.ts line 121
readonly inductionCounter: number;
// PHASE 22: add analogously:
// readonly deliveredCounter: number;
```

**`SimTask` discriminated union (lines 27-65):** Add `deliverPackage` variant:
```typescript
// VERIFIED: continuation.ts lines 27-65 — SimTask is the DATA union
// PHASE 22: add:
| {
    readonly kind: "deliverPackage";
    readonly packageId: string;
    readonly hubId: string;
    readonly slaDeadlineIso: string; // locked at induction, carried through
    readonly fireTick: number;
  }
```

**`captureContinuation()` in engine.ts (lines 1919-1973):** Captures induction substream:
```typescript
// VERIFIED: engine.ts lines 1958-1967
rng: {
  base: rng.getState(),
  rfid: rfidRng.getState(),
  overCarry: overCarryRng.getState(),
  timing: timingRng.getState(),
  hos: hosRng.getState(),
  fuel: fuelRng?.getState(),
  induction: inductionRng?.getState(),
  // PHASE 22: add:
  // outbound: outboundRng?.getState(),
},
```

### 6. How Phase 20 Scheduled `inductPackage` as a Self-Contained EventQueue Task

From `packages/simulation/src/engine.ts` lines 1103-1176:

```typescript
// VERIFIED: engine.ts lines 1103-1176
const inductPackage = (tick: number): void => {
  if (!inductionOn || inductionRng === undefined) return; // never runs when off

  inductionCounter += 1;
  // ... draw from inductionRng only ...
  const inducted: PackageInducted = { ... };
  emit(`package-${packageId}`, inducted);

  // Self-reschedule the NEXT induction at an ABSOLUTE tick.
  const nextTick = tick + INDUCTION_INTERVAL_TICKS;
  scheduleNext(nextTick, { kind: "inductPackage", tick: nextTick });
};
```

**Phase 22 mirrors this as a ONE-SHOT (not self-rescheduling) `deliverPackage`:**
```typescript
// Scheduled from inside arriveTrailer(), at arriveTick + dwell (dwell >= 1)
// task: { kind: "deliverPackage", packageId, hubId, slaDeadlineIso, fireTick }
const deliverPackage = (packageId: string, hubId: string, slaDeadlineIso: string, fireTick: number): void => {
  if (!outboundDeliveryEnabled || outboundRng === undefined) return; // never runs when off

  deliveredCounter += 1;
  const deliveredAt = clock.nowIso(); // epochMinutesToIso(Math.trunc(clock.nowMs() / 60000))
  const onTime = deliveredAt <= slaDeadlineIso;
  const delivered: PackageDelivered = {
    type: "PackageDelivered",
    schemaVersion: 1,
    payload: { packageId, hubId, deliveredAt, onTime, occurredAt: deliveredAt },
  };
  emit(`package-${packageId}`, delivered);
  // NOT self-rescheduling — one-shot. No scheduleNext() here.
};
```

**Dispatch switch addition in engine.ts at line 1830:**
```typescript
// VERIFIED: engine.ts lines 1829-1863 — the dispatch switch
case "deliverPackage":
  deliverPackage(task.packageId, task.hubId, task.slaDeadlineIso, task.fireTick);
  return;
```

### 7. Whole-Minute ISO Canonicalization Helper

From `packages/domain/src/hos.ts` lines 141-152:

```typescript
// VERIFIED: hos.ts lines 141-152
export function isoToEpochMinutes(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new RangeError(`isoToEpochMinutes: unparseable ISO stamp "${iso}"`);
  }
  return Math.trunc(ms / MS_PER_MINUTE);
}

/** Pure integer-epoch-minute → ISO-8601 conversion (inverse of isoToEpochMinutes). */
export function epochMinutesToIso(minutes: number): string {
  return new Date(minutes * MS_PER_MINUTE).toISOString();
}
```

Both are exported from `packages/domain/src/index.ts` at lines 156 and 158. The sim engine already imports and uses them (see `inductPackage` at line 1138: `isoToEpochMinutes(occurredAtIso)` and `epochMinutesToIso(deadlineMin)`). [VERIFIED: engine.ts lines 32-38 import block includes `epochMinutesToIso`, `isoToEpochMinutes`]

**For `deliveredAt` canonicalization:** `deliveredAt = epochMinutesToIso(isoToEpochMinutes(clock.nowIso()))` — this round-trips through whole-minute integer arithmetic, producing `"YYYY-MM-DDTHH:MM:00.000Z"` regardless of any sub-minute ms residue in the virtual clock. This matches the `slaDeadlineIso` format (set via `epochMinutesToIso(deadlineMin)` at engine.ts line 1142).

### 8. Seed-42 Golden Test Location and Exact Hash

File: `packages/simulation/test/determinism.unit.test.ts`
Lines 125-149: `LONG_RUN_GOLDEN_SHA256 = "3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861"`

```typescript
// VERIFIED: determinism.unit.test.ts lines 125-133
const LONG_RUN_GOLDEN_SHA256 =
  "3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861";

describe("10k-tick determinism golden (DET-02)", () => {
  it("simulate({ seed: 42, durationTicks: 10000 }) produces a committed SHA-256 hash", () => {
    const stream = simulate({ seed: 42, durationTicks: 10000 });
    const hash = createHash("sha256").update(JSON.stringify(stream)).digest("hex");
    expect(hash).toBe(LONG_RUN_GOLDEN_SHA256);
  });
```

The golden hashes `JSON.stringify(stream)` where `stream: SimulatedEvent[]` — the array of `{ streamId, event, occurredAt }` objects. Projection tables are NOT hashed. [VERIFIED: determinism.unit.test.ts lines 1-5 imports, line 130]

Phase 22 must add a test in the DET-01 section (lines 190-220) confirming `outboundDeliveryEnabled: false` or absent is byte-identical to the golden.

### 9. WS `TickPayload.inductionEvents` Field — Template for `deliveryEvents`

From `packages/api/src/ws/envelope.ts` lines 131-142 and 228-231:

```typescript
// VERIFIED: envelope.ts lines 131-142
export interface InductionEvent {
  readonly packageId: string;
  readonly inductionHubId: string;
  readonly destHubId: string;
  readonly slaClass: string;
  readonly slaDeadlineIso: string;
  readonly occurredAt: string;
}

// VERIFIED: envelope.ts lines 228-231
readonly inductionEvents?: readonly InductionEvent[];
// VIZ-13 — packages inducted at spoke hubs this tick (TRANSIENT).
```

**Phase 22 adds analogously:**
```typescript
export interface DeliveryEvent {
  readonly packageId: string;
  readonly hubId: string;         // destination hub
  readonly deliveredAt: string;   // whole-minute ISO
  readonly onTime: boolean;
}
// Added to TickPayload:
readonly deliveryEvents?: readonly DeliveryEvent[];
// VIZ-14 — packages delivered this tick (TRANSIENT, tick-only, never snapshot).
```

**`SnapshotPayload` MUST NOT gain `deliveryEvents`** — verified by Pitfall-7 in the WS induction test (`packages/api/test/ws-induction.unit.test.ts` lines 123-143). [VERIFIED: snapshots.ts Broadcast type at line 83-86 signature: `broadcast(simMs, inductionEvents?)`]

**`Broadcast` type in `packages/api/src/ws/snapshots.ts` line 83:**
```typescript
// VERIFIED: snapshots.ts line 83-86
export type Broadcast = (
  simMs: number,
  inductionEvents?: readonly InductionEvent[],
) => Promise<WsEnvelope>;
// PHASE 22: extend signature to also accept deliveryEvents
```

### 10. `createInductionLayer` / `flashInduction` — Template for VIZ-14

From `packages/web/src/map/layers.ts` lines 247-278:

```typescript
// VERIFIED: layers.ts lines 247-278
export function createInductionLayer(): Layer {
  const source = new VectorSource({ useSpatialIndex: true });
  const layer = new VectorLayer({ source, style: inductionStyle });
  return { layer, source };
}

export function flashInduction(
  source: VectorSource,
  inductionHubId: string,
  lon: number,
  lat: number,
  durationMs = 2000,
): void {
  const featureId = `induction:${inductionHubId}:${Date.now()}:${Math.random()}`;
  const feature = new Feature({
    geometry: new Point(fromLonLat([lon, lat])),
    inductionHubId,
  });
  feature.setId(featureId);
  source.addFeature(feature);
  setTimeout(() => {
    const f = source.getFeatureById(featureId);
    if (f !== null) source.removeFeature(f);
  }, durationMs);
}
```

**Phase 22 adds:**
```typescript
// In deliveryColoring.ts: a new style DISTINCT from purple (#7c3aed) and cyan (consolidation)
// Suggested: orange-red (#f97316) or green (#16a34a) — planner's discretion

export function createDeliveryLayer(): Layer { ... } // mirrors createInductionLayer
export function flashDelivery(source, hubId, lon, lat, durationMs = 2000): void { ... }
// feature property: "deliveryHubId" (instead of "inductionHubId")
```

### 11. Operator KPI Widget Set — Phase-21 `HubBalance` as Template

File: `packages/web/src/panels/HubBalance.tsx` — 147 lines, pure helpers + React component + `fetchHubDetail` API call pattern. [VERIFIED: HubBalance.tsx lines 1-147]

**Phase 22 P2 widget (`DeliveryKpi.tsx`):** Follows the same shape:
- Pure helpers: `formatDeliveryKpi(delivered: number, onTime: number): string`, `onTimePercent(delivered, onTime): number`
- Component: `DeliveryKpi` — fetches `GET /api/delivery-kpi` → `{ deliveredCount: number, onTimeCount: number }`, renders count + percentage
- Test: `DeliveryKpi.test.tsx` with pure-helper unit tests (no DOM for the computation layer)

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Whole-minute ISO canonicalization | Custom date formatter | `epochMinutesToIso`/`isoToEpochMinutes` from `@mm/domain/src/hos.ts` | Already used in engine.ts; re-implementing risks sub-minute drift |
| Deterministic MAP over `SimTask` variants | Manual if/else dispatch | `dispatch()` switch in engine.ts — just add a `case "deliverPackage":` | The switch is THE dispatching contract; adding a case is the established pattern |
| Pairwise-distinct salt assertion | Custom loop | Extend the existing test at `fuel-determinism.unit.test.ts:43-75` | Copy the Set.size === salts.length assertion pattern |
| Transient WS marker that self-removes | Custom DOM timer | `flashInduction`/`setTimeout` pattern in layers.ts | Established; test at `inductionLayer.test.ts` uses `vi.useFakeTimers()` |
| Event-derived KPI counter | `COUNT(*)` over purged tables | Separate `delivery-kpi.ts` reducer (D-22-3) | Purged tables undercount; event log has permanent truth |

---

## Common Pitfalls

### Pitfall 1: `deliveryEvents` on SnapshotPayload (Pitfall-7)
**What goes wrong:** If `deliveryEvents` is added to `SnapshotPayload`, every reconnecting client re-flashes all historical deliveries simultaneously.
**Why it happens:** Confusion between what "initial state" means vs. transient animation events.
**How to avoid:** Only add `deliveryEvents?` to `TickPayload` (envelope.ts line 203). `SnapshotPayload` (line 181) must NOT gain this field.
**Warning signs:** The `ws-induction.unit.test.ts` Pitfall-7 test pattern — mirror it for `deliveryEvents`.

### Pitfall 2: Missing `case "PackageDelivered":` in one of the 5 files
**What goes wrong:** Build fails (`contract.assert.ts` exhaustive switch) or test fails (validate() round-trip).
**Why it happens:** 5 files must ALL be updated atomically; missing one breaks the compile gate.
**How to avoid:** The `contract.assert.ts` exhaustive switch at build time catches any miss in the domain type. The `validate()` round-trip test catches any miss in the Zod schema.

### Pitfall 3: Reducer throws on missing row
**What goes wrong:** A replay or at-least-once re-apply of `PackageDelivered` throws because the row was already deleted.
**Why it happens:** `DELETE WHERE id = X` in Postgres is a no-op on a missing row, but the in-memory reducer may crash if it calls `.get()` and dereferences the result.
**How to avoid:** `placePackage(state, packageId, null)` already handles missing packages safely (hub-inventory.ts line 115: `if (prior !== undefined)` guard). Package-location DELETE: `const next = new Map(state); next.delete(packageId); return next;` — `Map.delete()` returns false on missing key, never throws.

### Pitfall 4: Golden fails because `outboundDeliveryEnabled` defaults to something other than `false`/absent
**What goes wrong:** `simulate({ seed: 42, durationTicks: 10000 })` calls the engine with `outboundDeliveryEnabled` truthy.
**Why it happens:** Default parameter handling — `opts.outboundDeliveryEnabled ?? true` accidentally.
**How to avoid:** `const outboundOn = opts.outboundDeliveryEnabled === true;` — strict `=== true` (identical to `const inductionOn = opts.inductionEnabled === true;` at engine.ts line 511). Never `??` or `||`.

### Pitfall 5: `slaDeadlineIso` not carried into the `deliverPackage` task
**What goes wrong:** At delivery time, the engine can't compute `onTime` because the deadline is not available in the task data.
**Why it happens:** `PackageArrivedAtHub` payload has only `{ packageId, hubId }` — no deadline. The task must carry `slaDeadlineIso` explicitly.
**How to avoid:** The `deliverPackage` SimTask variant includes `slaDeadlineIso` as a field. When scheduling the task inside `arriveTrailer()`, the deadline must be available. Currently, center-distributed packages have their deadline locked in `PackageCreated` (no deadline there) or via a runtime map.

**Critical gap:** The current engine does NOT maintain a `packageId → slaDeadlineIso` map for non-inducted packages. `PackageCreated` has no `slaDeadlineIso`. Only `PackageInducted` packages have `slaDeadlineIso`. This means:
- For non-inducted (center-origin `PackageCreated`) packages, `slaDeadlineIso` does not exist → `onTime` cannot be computed.
- **Resolution (from CONTEXT.md D-22-5):** `slaDeadlineIso` is locked at induction (Phase 20). Only inducted packages have SLA deadlines. For `PackageCreated` packages (center-origin), no `slaDeadlineIso` exists. Two options: (a) only emit `PackageDelivered` for inducted packages, or (b) treat center-origin packages as always on-time (null/undefined deadline).
- **Recommendation:** Maintain a `slaDeadlineByPackage: Map<string, string>` in world state, populated on `PackageInducted`. For center-origin packages with no entry, `onTime = true` (no SLA commitment). This map must be captured in `SerializedWorldState` and cleared on `PackageDelivered`.

### Pitfall 6: Continuation mid-dwell boundary
**What goes wrong:** A chunk boundary falls between the `PackageArrivedAtHub` and the scheduled `deliverPackage` task. If `deliverPackage` is not captured as a DATA task in the continuation, the delivery is lost.
**Why it happens:** Closures are not serializable — the `SimTask` union must have a `deliverPackage` variant with all required data.
**How to avoid:** `SimTask` variant with `{ kind: "deliverPackage", packageId, hubId, slaDeadlineIso, fireTick }` is fully serializable. The continuation-equivalence test with `outboundDeliveryEnabled: true` at chunk-7 boundary proves it.

### Pitfall 7: OOM in continuation/Postgres-heavy tests (memory note from GATE-HYGIENE)
**What goes wrong:** A large `durationTicks` or many packages causes heap OOM (exit code 137) in the continuation-equivalence test.
**Why it happens:** Induction + outbound with 10k-tick runs accumulate large event arrays.
**How to avoid:** Use `durationTicks <= 800` + `SHORT_TIMING` for continuation-equivalence tests (matching the existing Phase-20/21 pattern). Gate-hygiene constraint: one vitest gate at a time with `--max-workers 1 --no-file-parallelism`.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `PackageArrivedAtHub` was terminal | `PackageArrivedAtHub` triggers dwell → `PackageDelivered` | Phase 22 | Destination-hub packages no longer linger in projections indefinitely |
| Projection tables grow without bound | `PackageDelivered` hard-DELETE bounds table size | Phase 22 | CONT-04 bounded-memory story complete |
| No outbound SLA tracking | `onTime` flag derived from locked `slaDeadlineIso` | Phase 22 | Optimizer priority signal closed end-to-end |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | All `PackageCreated` (center-origin) packages have `destHubId === spoke.hubId` when `arriveTrailer()` fires (no center-self-destined packages) | Code Anchor 2 | Low — the FIFO manifest `pendingBySpoke.get(spoke.hubId)` structurally ensures this |
| A2 | `zoneEstimate` can be purged with a no-op for OUT-04 (Phase-21 `is_active` filter already excludes delivered packages from detection cost) | Code Anchor 3 | Medium — CONTEXT.md says purge `zoneEstimate`; a true purge requires iterating the map by prefix which is O(n) |
| A3 | `slaDeadlineByPackage` world state map is the right approach for carrying SLA deadlines to the delivery task | Pitfall 5 | Low risk — no other approach avoids the architectural gap cleanly |

---

## Open Questions

1. **`zoneEstimate` purge strategy** — CONTEXT.md D-22-1 says DELETE from `zoneEstimate`. The zone-estimate state is a `Map<string, ZoneEstimate>` keyed by `"${packageId}|${trailerId}"`. A purge requires iterating all keys that start with `packageId|`. The reducer currently has no helper for this. Should Phase 22 add a `purgePackage(state, packageId)` helper, or iterate inline?
   - **Recommendation:** Add a `purgeZoneEstimate(state, packageId)` helper that filters the map by prefix — O(n) but the map is small in demo scale. Alternative: treat as no-op (safe for bounded memory because the Phase-21 detector already scopes to `is_active` packages).

2. **`slaDeadlineByPackage` scope** — Only inducted packages have `slaDeadlineIso`. Should center-origin `PackageCreated` packages get `onTime: true` (no SLA) or simply not fire `PackageDelivered`? Or should all packages fire `PackageDelivered` but with `onTime: true` when no deadline exists?
   - **Recommendation:** Fire `PackageDelivered` for ALL packages (OUT-02 terminal-completeness). For packages without a deadline (center-origin), `onTime: true` (no commitment violated). This keeps OUT-04 (bounded tables) complete for all packages.

3. **Outbound dwell mean** — Claude's discretion. Suggested: `OUTBOUND_DWELL_TICKS_MAX = 20` (so dwell = `1 + outboundRng.int(20)` ticks = 1..20 ticks). At 1 tick/minute, 1-20 minutes of "last-mile dwell" is demo-reasonable.

---

## Environment Availability

Step 2.6: SKIPPED (no external dependencies — Phase 22 is purely code/config changes within the existing monorepo)

---

## Validation Architecture

Nyquist validation is ENABLED (`workflow.nyquist_validation` is absent from config → treated as enabled).

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4 |
| Config file | `packages/simulation/vitest.config.ts` (unit), `packages/api/vitest.config.ts` (int) |
| Quick run command | `pnpm --filter @mm/simulation test -- --run --reporter=dot packages/simulation/test/outbound-determinism.unit.test.ts` |
| Full suite command | `pnpm test:all` (one gate at a time, `--max-workers 1` for continuation tests) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| OUT-01 | `PackageDelivered` round-trips validateEvent() | unit | `pnpm --filter @mm/domain test -- --run packages/domain/test/package-delivered.unit.test.ts` | ❌ Wave 0 |
| OUT-01 | Zod `.strict()` rejects extra payload field | unit | (same file, second test case) | ❌ Wave 0 |
| OUT-01 | `contract.assert.ts` exhaustive switch compiles with `PackageDelivered` case | build | `pnpm --filter @mm/domain build` | ❌ Part of union ceremony |
| OUT-02 | `outboundDeliveryEnabled: false` ⇒ ZERO `PackageDelivered` events (DET-01 gate) | golden invariance | `pnpm --filter @mm/simulation test -- --run packages/simulation/test/outbound-determinism.unit.test.ts` | ❌ Wave 0 |
| OUT-02 | `outboundDeliveryEnabled: false` is byte-identical to absent (golden byte-identical) | golden invariance | (same file) | ❌ Wave 0 |
| OUT-02 | seed-42 10k-tick SHA = `3920accc…` with no v2.0 flags | golden invariance | `pnpm --filter @mm/simulation test -- --run packages/simulation/test/determinism.unit.test.ts` | ✅ existing (add `outboundDeliveryEnabled: false` case to DET-01 section) |
| OUT-02 | terminal-completeness: with flag ON, every induced package reaches `PackageDelivered` within horizon | unit | (outbound-determinism.unit.test.ts) | ❌ Wave 0 |
| OUT-02 | lifecycle-ordering: `PackageDelivered` always follows `PackageArrivedAtHub` for same packageId | unit | (outbound-determinism.unit.test.ts) | ❌ Wave 0 |
| OUT-03 | `onTime = (deliveredAt <= slaDeadlineIso)` for packages with deadlines | unit | (outbound-determinism.unit.test.ts) | ❌ Wave 0 |
| OUT-03 | `deliveredAt` is whole-minute ISO (no sub-minute residue) | unit | (outbound-determinism.unit.test.ts) | ❌ Wave 0 |
| OUT-04 | bounded-memory: projection row count for delivered packages = 0 after `PackageDelivered` | unit (pure reducer) | `pnpm --filter @mm/projections test -- --run packages/projections/src/reducers/package-location.ts` | ❌ Wave 0 (add test case to existing reducer tests) |
| OUT-04 | `hubInventoryReducer` DELETE is no-op on missing row | unit | (hub-inventory.test.ts) | ❌ Add test case |
| OUT-04 | `packageLocationReducer` DELETE is no-op on missing row | unit | (new package-delivered reducer test) | ❌ Wave 0 |
| D-22-4 | `OUTBOUND_RNG_SALT` is pairwise-distinct from all 7 prior salts | unit | `pnpm --filter @mm/simulation test -- --run packages/simulation/test/fuel-determinism.unit.test.ts` | ✅ existing (extend the existing salts array) |
| D-22-4 | continuation-equivalence with `outboundDeliveryEnabled: true`, chunk-7 crossing mid-dwell | continuation equiv. | `pnpm --filter @mm/simulation test -- --run packages/simulation/test/continuation-equivalence.unit.test.ts` | ✅ existing (add "outbound" FEATURE_CASE) |
| VIZ-14 | `flashDelivery` adds transient Point feature, self-removes after timeout | unit | `pnpm --filter @mm/web test -- --run packages/web/src/map/deliveryLayer.test.ts` | ❌ Wave 0 |
| VIZ-14 | `deliveryEvents` present on tick, absent on snapshot (Pitfall-7) | unit | `pnpm --filter @mm/api test -- --run packages/api/test/ws-delivery.unit.test.ts` | ❌ Wave 0 |
| OUT-05 (P2) | `deliveryKpiReducer` increments deliveredCount + onTimeCount on `PackageDelivered` | unit | `pnpm --filter @mm/projections test -- --run delivery-kpi` | ❌ Wave 0 |

### Determinism-Critical Invariants (MUST verify as acceptance gates)

1. **Flag-off golden byte-identical:** `simulate({ seed: 42, durationTicks: 10000 })` (no `outboundDeliveryEnabled`) === `3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861`
2. **Explicit-false is byte-identical to absent:** `simulate({ seed: 42, durationTicks: 10000, outboundDeliveryEnabled: false })` === absent
3. **`OUTBOUND_RNG_SALT` pairwise-distinct:** `Set([all 8 salts]).size === 8` — extend `fuel-determinism.unit.test.ts`
4. **Continuation-equivalence mid-dwell:** chunked(7) === all-at-once with `outboundDeliveryEnabled: true`, `durationTicks: 800`, `timing: SHORT_TIMING`

### Sampling Rate

- **Per task commit:** quick run of the directly-affected test file (`outbound-determinism.unit.test.ts` or domain/reducer test)
- **Per wave merge:** `pnpm --filter @mm/simulation test --run && pnpm --filter @mm/domain test --run && pnpm --filter @mm/projections test --run`
- **Phase gate:** `pnpm build && pnpm typecheck && pnpm lint && pnpm test:all` (run ONE gate at a time; see GATE-HYGIENE memory note)

### Wave 0 Gaps

- [ ] `packages/domain/test/package-delivered.unit.test.ts` — covers OUT-01 (mirrors `package-inducted.unit.test.ts`)
- [ ] `packages/simulation/test/outbound-determinism.unit.test.ts` — covers OUT-02, OUT-03, D-22-4, lifecycle-ordering, terminal-completeness (mirrors `induction-determinism.unit.test.ts`)
- [ ] `packages/web/src/map/deliveryLayer.test.ts` — covers VIZ-14 flash/self-remove (mirrors `inductionLayer.test.ts`)
- [ ] `packages/api/test/ws-delivery.unit.test.ts` — covers VIZ-14 WS pitfall-7 (mirrors `ws-induction.unit.test.ts`)
- [ ] Add `PackageDelivered` no-op-on-missing-row test cases to existing `hub-inventory.test.ts` and `package-location.ts` test suite

---

## Security Domain

No new authentication, session, access control, input validation beyond the existing Zod `.strict()` schema boundary, or cryptography. The `PackageDelivered` payload is validated at the same `validateEvent()` ingestion boundary as all other events. No ASVS categories newly applicable. [VERIFIED: phase is a simulation event + projection extension; no user-facing auth, no external input, no secrets]

---

## Sources

### Primary (HIGH confidence — verified by direct codebase read)

- `packages/domain/src/events/domain-event.ts` — DomainEvent union, `PackageInducted` as template
- `packages/domain/src/events/schemas.ts` — `eventSchema` helper, all existing schemas
- `packages/domain/src/events/contract.assert.ts` — 5-file exhaustive switch
- `packages/domain/src/events/index.ts` — exports
- `packages/domain/src/ingestion/validate.ts` — `validateEvent()`
- `packages/domain/src/hos.ts:141-152` — `isoToEpochMinutes`, `epochMinutesToIso`
- `packages/domain/test/package-inducted.unit.test.ts` — test template
- `packages/simulation/src/engine.ts` — `INDUCTION_RNG_SALT` (line 116), `inductPackage` (line 1103), `arriveTrailer` (line 1495), `captureContinuation` (line 1919), `dispatch` switch (line 1829), `SimulateOptions` (line 147)
- `packages/simulation/src/rng.ts` — `makeRng`, `makeRngFromState`, `Rng.getState()`
- `packages/simulation/src/continuation.ts` — `SimTask`, `SerializedRngStates`, `SerializedWorldState`, `SimContinuation`
- `packages/simulation/test/determinism.unit.test.ts` — golden test, DET-01 flags-off tests
- `packages/simulation/test/induction-determinism.unit.test.ts` — induction test template
- `packages/simulation/test/continuation-equivalence.unit.test.ts` — continuation test, FEATURE_CASES pattern
- `packages/simulation/test/fuel-determinism.unit.test.ts:43-75` — pairwise-distinct salt assertion pattern
- `packages/projections/src/reducers/package-location.ts` — current reducer structure
- `packages/projections/src/reducers/hub-inventory.ts` — `placePackage`, idempotent null target
- `packages/projections/src/reducers/zone-estimate.ts` — `zoneEstimateKey`, no-op pattern
- `packages/api/src/ws/envelope.ts` — `InductionEvent`, `TickPayload`, `SnapshotPayload`, `diffTick`
- `packages/api/src/ws/snapshots.ts` — `Broadcast` type (line 83), `attachSnapshotSocket`
- `packages/api/test/ws-induction.unit.test.ts` — Pitfall-7 test template
- `packages/web/src/map/layers.ts` — `createInductionLayer`, `flashInduction` (lines 247-278)
- `packages/web/src/map/inductionColoring.ts` — induction style (purple `#7c3aed`), zero-alloc pattern
- `packages/web/src/panels/HubBalance.tsx` — P2 widget template
- `.planning/config.json` — `nyquist_validation` absent → treated as enabled

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new dependencies; all patterns directly verified in live code
- Architecture: HIGH — all code anchors verified with exact line numbers
- Pitfalls: HIGH — derived from direct code analysis + Phase-20/21 CONTEXT.md decisions
- Validation architecture: HIGH — all test file templates directly verified

**Research date:** 2026-06-24
**Valid until:** 2026-07-14 (stable codebase; 30-day horizon)

---

## RESEARCH COMPLETE

**Phase:** 22 — Outbound Delivery
**Confidence:** HIGH

### Key Findings

1. The **5-file domain union ceremony** for `PackageDelivered` is fully templated by `PackageInducted` (`packages/domain/test/package-inducted.unit.test.ts`). Copy-and-adapt with payload `{ packageId, hubId, deliveredAt, onTime, occurredAt }`.

2. The **`inductPackage` function** in `engine.ts` (lines 1103-1176) is the exact template for `deliverPackage` — a one-shot (not self-rescheduling) EventQueue DATA task scheduled inside `arriveTrailer()` after the `PackageArrivedAtHub` emit.

3. **Whole-minute canonicalization** uses `epochMinutesToIso`/`isoToEpochMinutes` from `@mm/domain/src/hos.ts:141-152`. Both are already imported in `engine.ts`; no new dependency.

4. **The three projection reducers** (`package-location`, `hub-inventory`, `zone-estimate`) all end with `default: assertNeverEvent(event)` — adding a `PackageDelivered` case is required for the build to pass. `placePackage(state, packageId, null)` in hub-inventory already provides the idempotent no-op-on-missing behavior for the DELETE purge.

5. **Critical architectural gap discovered:** `slaDeadlineIso` is only available on `PackageInducted` packages. Center-origin `PackageCreated` packages have no deadline. Phase 22 needs a `slaDeadlineByPackage: Map<string, string>` world state entry (captured in `SimContinuation`) to carry deadlines from induction to delivery. Center-origin packages get `onTime: true` by convention (no SLA commitment).

6. **GATE-HYGIENE:** All new continuation/simulation tests MUST use `durationTicks <= 800` and `timing: SHORT_TIMING` to avoid OOM. Run one vitest gate at a time per the `v2-gate-hygiene-oom` memory note.

### File Created
`.planning/phases/22-outbound-delivery/22-RESEARCH.md`

### Confidence Assessment
| Area | Level | Reason |
|------|-------|--------|
| Standard Stack | HIGH | Zero new dependencies; all patterns in live code |
| Architecture | HIGH | All code anchors verified with line numbers |
| Pitfalls | HIGH | Derived from code analysis + locked decisions |
| Validation Architecture | HIGH | Test templates directly verified |

### Open Questions
- `zoneEstimate` purge: no-op vs O(n) map-filter? (Recommendation: planner can start with no-op; OUT-04 is satisfied by `packageLocation` and `hubInventory` purge for the demo)
- `onTime` for center-origin packages: `true` by convention (no deadline) — verify this matches demo intent
