# Phase 22 — Exact Code Anchors (read-only map; verified 2026-06-25)

Pinned by a read-only code explorer. Implementers: verify each line still matches before editing
(the file may have shifted by a few lines). All paths under repo root.

## 1. `PackageDelivered` event — union ceremony (mirror Phase-20 `PackageInducted`)
- `packages/domain/src/events/schemas.ts` — after `packageInductedSchema` (~L415-441) add:
  ```ts
  export const packageDeliveredSchema = eventSchema(
    "PackageDelivered",
    z.object({
      packageId: id,
      hubId: id,
      deliveredAt: z.string().min(1),
      onTime: z.boolean(),
    }),
  );
  ```
  and add `packageDeliveredSchema,` to the discriminated-union array (~L448-478, end ~L477).
- `packages/domain/src/events/domain-event.ts` — add `export type PackageDelivered = z.infer<typeof packageDeliveredSchema>;`
  (~L63 region) and `| PackageDelivered` to the `DomainEvent` union (~L165-194).
- `packages/domain/src/events/index.ts` — export the type (~L28-30) and the schema (~L58-60).
- `packages/domain/src/events/contract.assert.ts` — add `case "PackageDelivered":` to the switch
  (~L25-54); `default: assertNever(event)` enforces exhaustiveness (compile-time).

## 2. Arrival emit sites (today NOT terminal) — `packages/simulation/src/engine.ts`
- Primary spoke-arrival: **L1554-1559** `emit(\`package-${packageId}\`, atHub)` after unload scan.
- Over-carried at center: **L1742-1747**.
- Consolidation at center: **L1786-1791**.
- After arrival a package goes to `hub_inventory.inbound` and may re-stage into `pendingBySpoke`.
  Phase 22: when a package arrives at its **destination** hub, schedule a `deliverPackage` dwell task
  instead of leaving it terminal. (Only destination arrivals deliver — center/cross-dock arrivals
  continue onward as today.)

## 3. Projection purge reducers (DELETE on `PackageDelivered`)
- `packages/projections/src/reducers/package-location.ts` — `PackageLocationState = Map<packageId, …>`;
  reducer `packageLocationReducer(state, {event, occurredAt})` (~L60-75). Purge: `state.delete(packageId)`.
- `packages/projections/src/reducers/hub-inventory.ts` — keyed by hubId; buckets inbound/outbound/staged;
  helper `placePackage(state, packageId, null)` (~L106-132) removes a packageId from all buckets.
  reducer `hubInventoryReducer(state, {event})` (~L158-161).
- `packages/projections/src/reducers/zone-estimate.ts` — composite key `zoneEstimateKey(packageId, trailerId)`
  = `${packageId}|${trailerId}` (~L76); `makeZoneEstimateReducer(deps)` (~L117-129). Purge: delete every
  key starting with `${packageId}|`.
- ALL purges must be **idempotent no-ops on a missing row** (never throw) — D-22-1.

## 4. RNG salts — `packages/simulation/src/engine.ts` L84-116
Existing (6): `RFID_RNG_SALT=0x5f1da7c3`, `OVER_CARRY_RNG_SALT=0x3ca71d5f`, `TIMING_RNG_SALT=0x00007717`,
`HOS_RNG_SALT=0x10510901`, `FUEL_RNG_SALT=0x2b3d91e7`, `INDUCTION_RNG_SALT=0x8f2c4ae1`.
Add `OUTBOUND_RNG_SALT = 0xc4_f8_32_b6` (~L117).
Pairwise-distinct test: `packages/simulation/test/fuel-determinism.unit.test.ts` L60-75 — extend the
salts array + `new Set(salts).size === salts.length` assertion to include the 7th.

## 5. `SimContinuation` — `packages/simulation/src/continuation.ts`
- DTO L142-168 (`rng`, `queue`, `nextSeq`, `world`, `nextSequenceId`, …).
- `SerializedRngStates` L125-136 — add `readonly outbound: number | undefined;`.
- `SerializedWorldState` L90-123 (has pendingBySpoke / pendingAtSpoke / consolidationDestByPackage /
  …counters incl. `inductionCounter`). Add `pendingDeliveryByHub` (or carry dwell in the task) +
  `deliveryCounter` + **`slaDeadlineByPackage`** (see §7 — needed so a delivery can compute onTime
  deterministically after a continuation boundary).
- `SimTask` union L27-65 — add `| { kind: "deliverPackage"; tick: number; packageId: string; hubId: string }`
  (carry `slaDeadlineIso` in the task too if not kept in world map).
- `captureContinuation()` engine.ts **L1919-1973** — add `outbound: outboundDeliveryRng?.getState()`
  to `rng` and the new world fields. (Mirror induction exactly.)

## 6. Event-queue comparator (LEAVE UNCHANGED — D-22-2)
- `packages/simulation/src/engine.ts` `class EventQueue` L393-445; comparator `(a,b)=> a.fireTick!==b.fireTick ? a.fireTick-b.fireTick : a.seq-b.seq` at **L421-422** (pop) and **L440-441** (snapshot).
- Strictly-positive dwell guarantees delivery tick > arrival tick → no comparator change.

## 7. SLA deadline / onTime — `packages/simulation/src/engine.ts`
- Deadline locked at induction: L1138-1142 (`deadlineMin = isoToEpochMinutes(occurredAtIso) + round(transitMin) + SLA_BUFFER_MIN[slaClass]`), emitted in `PackageInducted.payload.slaDeadlineIso` (L1152).
- Clock: `clock.nowIso()` (L1137) — ISO-8601 string, never `Date.now()`.
- onTime = `deliveredAt <= slaDeadlineIso` (ISO-8601 is lexicographically ordered).
- **Open impl detail:** the engine must retain `slaDeadlineIso` per package (a `slaDeadlineByPackage`
  map populated at induction) so the later `deliverPackage` task can compute onTime — and that map MUST
  be in `SerializedWorldState` for continuation-equivalence. Packages WITHOUT an induction deadline
  (legacy `PackageCreated` distribution freight) need a defined onTime policy (e.g. onTime=true / omit) —
  resolve in plan; OUT-03 frames onTime around inducted packages.

## 8. `SimulateOptions` flag — `packages/simulation/src/engine.ts` L147-301
Existing v2.0 flags: `hosEnabled?` (L196), `inductionEnabled?` (L281), `consolidationEnabled?` (L300).
Add `readonly outboundDeliveryEnabled?: boolean;` (~L301) — DEFAULT FALSE = determinism keystone.

## 9. Golden determinism test — `packages/simulation/test/determinism.unit.test.ts` L110-149
`simulate({seed:42, durationTicks:10000})` → `createHash("sha256").update(JSON.stringify(stream)).digest("hex")`
=== `LONG_RUN_GOLDEN_SHA256 = "3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861"` (L125-126, 6172 events).
Hashes the EVENT STREAM, not projections. Flag-off must keep this byte-identical. (seed-1234 golden likewise.)

## 10. WS tick + map (VIZ-14)
- `packages/api/src/ws/envelope.ts` — `TickPayload` L203-232 (has `inductionEvents?`); `InductionEvent` L135-140.
  Add `deliveryEvents?: readonly DeliveryEvent[]` + `interface DeliveryEvent { packageId: string; hubId: string; deliveredAt: string; onTime: boolean; }`.
- `packages/api/src/ws/snapshots.ts` L834-850 — inject `deliveryEvents` (tick-only; NEVER in snapshot →
  no reconnect re-flash, Phase-20 Pitfall-7). Driver collects per-tick on all paths (mirror inductionEvents).
- `packages/web/src/map/layers.ts` L240-278 — add `createDeliveryLayer()` + `flashDelivery(source, hubId, lon, lat, onTime, durationMs=2000)` mirroring `createInductionLayer`/`flashInduction`; distinct style from VIZ-13 purple / VIZ-12 cyan.
- `packages/web/src/map/MapView.tsx` L163 (layer construction) + L388 (envelope handler hook).
- OUT-05 KPI: new event-derived `delivery_kpi` projection (deliveredCount, onTimeCount) → API → operator widget (cf. Phase-21 `HubBalance` panel). NOT a row-count over purged tables (D-22-3).
