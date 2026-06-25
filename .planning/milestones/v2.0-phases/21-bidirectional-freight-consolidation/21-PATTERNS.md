# Phase 21: Bidirectional Freight / Consolidation - Pattern Map

**Mapped:** 2026-06-24
**Files analyzed:** 17 (15 modified existing + 2 net-new artifacts with templates)
**Analogs found:** 17 / 17 (every concern has a tested in-repo precedent — this is a purely additive phase)

> Every line anchor below was re-verified by reading the actual source this session. Where RESEARCH.md anchors had drifted, the corrected line is noted inline. All excerpts are read-only references for the planner's executors to MIRROR — do not modify the analog files.

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `packages/simulation/src/engine.ts` (`pendingAtSpoke` + consolidation departure/re-sort + flag) | engine / domain core | event-driven (manifest drain → emit) | `pendingBySpoke` + over-carry return leg + `arriveOverCarriedAtCenter` (same file) | exact (self-analog) |
| `packages/simulation/src/continuation.ts` (`SimTask` variant + `SerializedWorldState.pendingAtSpoke`) | serialization / DTO | transform (state → JSON) | `arriveOverCarriedAtCenter` `SimTask` + `pendingBySpoke` field (same file) | exact |
| `packages/domain/src/events/schemas.ts` (`planSupersededSchema`) | domain event schema | transform (validate) | `planAcceptedSchema` / `packageInductedSchema` | exact |
| `packages/domain/src/events/domain-event.ts` (`PlanSuperseded` type + union) | domain type | — | `PackageInducted` type + `DomainEvent` union | exact |
| `packages/domain/src/events/contract.assert.ts` (`case "PlanSuperseded"`) | build-gate fixture | — | `case "PackageInducted"` | exact |
| `packages/domain/src/events/index.ts` + `packages/domain/src/index.ts` (exports) | barrel export | — | `PackageInducted`/`packageInductedSchema` exports | exact |
| `packages/domain/src/events/plan-superseded.test.ts` (or extend `plan-events.test.ts`) | test | — | `plan-events.test.ts` round-trip + strict-reject | exact |
| `packages/projections/src/reducers/hub-inventory.ts` (`PlanSuperseded` delete-then-apply; `PlanAccepted` stage) | reducer | event-driven (fold) | the existing `placePackage`/`withoutPackage` + `PlanAccepted` no-op (same file) | exact |
| `packages/projections/src/reducers/*.ts` (10 others: `case "PlanSuperseded": return state`) | reducer | event-driven (fold) | the existing closed-switch + `assertNeverEvent` default | exact |
| `packages/projections/src/detector.ts` (`is_active` scoping) | projection read adapter | request-response (query) | `makeProjectionReads` `selectAll()` reads (same file) | role-match (net-new predicate) |
| `packages/event-store/src/schema.sql` + `schema.ts` (`optimizer_idempotency` DDL) | migration / schema | — | `projection_checkpoints` table (CREATE TABLE IF NOT EXISTS) | exact (table template) |
| `packages/api/src/optimizer/rolling-service.ts` (Postgres idempotency + emit `PlanSuperseded`) | service shell (side-effecting writer) | CRUD (claim epoch) + event-driven (append) | `memo` LruMap + `appendPlan` atomic append (same file) | exact |
| `packages/api/src/optimizer/twin-snapshot.ts` (`ORDER BY` on projection SELECTs) | read adapter | request-response (query) | the unordered `selectAll().execute()` (same file) | exact (delta = add ORDER BY) |
| `packages/api/src/ws/envelope.ts` (`TrailerKeyframe.direction` + `trailerChanged`) | wire DTO | streaming (server→client diff) | `TrailerKeyframe.util` optional field + `trailerChanged` diff (same file) | exact |
| `packages/api/src/ws/snapshots.ts` (derive `direction` in `buildTrailerKeyframes`) | snapshot builder | streaming | `routeId = legRouteId(from,to)` derivation (same file) | exact |
| `packages/api/src/routes/hub-detail.ts` (FLOW-05 inbound/outbound balance) | read API route | request-response | the existing `GET /hubs/:id/detail` route (same file) | exact |
| `packages/web/src/map/coloring.ts` + `layers.ts` (VIZ-12 direction style) | map layer / style fn | rendering | `trailerStyle` + `inductionColoring.ts` + `upsertTrailerKeyframe` | exact |
| `packages/web/src/panels/` (FLOW-05 hub balance widget) | UI panel (React) | request-response | `MoneySlide.tsx` panel (fetch + pure helpers) | role-match |

---

## Pattern Assignments

### Concern 1 — `pendingAtSpoke` two-queue manifest (engine.ts + continuation.ts)

**Role:** engine / domain core · **Data flow:** event-driven (manifest populate → atomic drain → emit → capture)
**Analog:** the existing `pendingBySpoke` lifecycle in `packages/simulation/src/engine.ts` (4 touch-points), serialized via `packages/simulation/src/continuation.ts`.
**Delta:** add an identical four-touch-point `pendingAtSpoke` Map (init/restore, atomic drain, capture, serialize). Apply a deterministic sort key (`[priority]+[tick]+[freightId]`) to `pendingAtSpoke` ONLY — do NOT perturb `pendingBySpoke`'s FIFO order (every golden would shift). All four sites gated behind `if (!consolidationOn) return;`.

**Touch-point A — init + restore-from-continuation** (`engine.ts:966-972`, anchor confirmed):
```typescript
const pendingBySpoke = new Map<string, string[]>();
if (resuming) {
  for (const [hubId, ids] of start.world.pendingBySpoke) {
    pendingBySpoke.set(hubId, [...ids]);
  }
}
for (const s of spokes) if (!pendingBySpoke.has(s.hubId)) pendingBySpoke.set(s.hubId, []);
```

**Touch-point B — atomic drain at departure** (`engine.ts:1283-1284`, anchor confirmed; inside `departTrailer`):
```typescript
// Drain this spoke's pending manifest onto the trailer (load scans first).
const manifest = pendingBySpoke.get(spoke.hubId)!;
const loaded = manifest.splice(0, manifest.length);   // ATOMIC peek+pop (satisfies the double-drain guard)
```

**Touch-point C — capture into `SimContinuation.world`** (`engine.ts:1722-1741`, inside `captureContinuation`; the `pendingBySpoke` field is at `1724-1726`, RESEARCH said 1724 — confirmed):
```typescript
function captureContinuation(): SimContinuation {
  const world: SerializedWorldState = {
    pendingBySpoke: [...pendingBySpoke.entries()].map(
      ([k, v]) => [k, [...v]] as const,
    ),
    // ... odometerByTrailer, driverByTrailer, clockByDriver, ... packageCounter, tripCounter, inductionCounter
  };
```

**Touch-point D — the serialized field shape** (`continuation.ts:80-99`, `SerializedWorldState`; `pendingBySpoke` field at `81-82`):
```typescript
export interface SerializedWorldState {
  /** Per-spoke FIFO manifest of pending package ids (hubId → packageId[]). */
  readonly pendingBySpoke: readonly (readonly [string, readonly string[]])[];
  // ... add: readonly pendingAtSpoke: readonly (readonly [string, readonly string[]])[];
  readonly packageCounter: number;
  readonly tripCounter: number;
  readonly inductionCounter: number;
}
```

**Determinism note (Pitfall 1, locked):** add NO new RNG. Do NOT add a `consolidation` field to `SerializedRngStates` (`continuation.ts:102-112`) and do NOT touch the salt-collision test (`fuel-determinism.unit.test.ts:41-74`). Consolidation reuses existing freight (induction-origin or center-distribution packages already drawn). The double-drain guard is satisfied by `splice(0, length)` (atomic) + iterating trailers in stable `trailerRoster` order (`engine.ts:946`).

---

### Concern 2 — Consolidation departure + center re-sort (engine.ts)

**Role:** engine / domain core · **Data flow:** event-driven (spoke→center `TrailerDeparted` → scheduled center arrival → unload + re-stage)
**Analog:** the over-carry return leg (`engine.ts:1503-1547`, anchor confirmed) + `arriveOverCarriedAtCenter` (`engine.ts:1581-1613`, anchor confirmed). This is THE literal precedent — the ONLY existing place a `TrailerDeparted.fromHubId != center` is produced.
**Delta:** a new `arriveConsolidationAtCenter` task does the SAME unload + `PackageArrivedAtHub@center`, then **re-stages each package into `pendingBySpoke[destSpoke]`** (the package's `destHubId`, a different spoke per Decision 2) so the existing center→spoke distribution picks it up — the cross-dock. Drains `pendingAtSpoke` (not a single `heldBack`) and does NOT draw the over-carry rate. Add the variant to the `SimTask` union + a `case` in `dispatch`.

**Spoke-origin departure** (`engine.ts:1513-1524`, inside the over-carry `if (heldBack !== undefined)` block at `1508`):
```typescript
const returnDeparted: TrailerDeparted = {
  type: "TrailerDeparted",
  schemaVersion: 1,
  payload: {
    trailerId,
    fromHubId: spoke.hubId,   // ← spoke-origin: the ONLY non-center fromHubId today
    toHubId: center.hubId,
    tripId: returnTripId,
    packageIds: overCarried,  // ← consolidation: replace with `loaded` drained from pendingAtSpoke
  },
};
emit(`trailer-${trailerId}`, returnDeparted);

// Schedule the return arrival at the center (a fresh per-departure transit draw).
const returnArriveTick = arriveTick + drawTransitTicks(spoke.hubId, center.hubId);
schedule(returnArriveTick, {
  kind: "arriveOverCarriedAtCenter",   // ← consolidation: new `arriveConsolidationAtCenter` variant
  trailerId,
  packageId: overCarriedId,            // ← consolidation: carry the drained packageIds array
  tripId: returnTripId,
});
```

**Center arrival: unload scan + `PackageArrivedAtHub@center`** (`engine.ts:1600-1612`, inside `arriveOverCarriedAtCenter`; the handler also emits `TrailerArrivedAtHub`+`TrailerDocked` at `1586-1598`):
```typescript
const unload: PackageScanned = {
  type: "PackageScanned",
  schemaVersion: 1,
  payload: { packageId, hubId: center.hubId, scanType: "unload" },
};
emit(`package-${packageId}`, unload);

const atHub: PackageArrivedAtHub = {
  type: "PackageArrivedAtHub",
  schemaVersion: 1,
  payload: { packageId, hubId: center.hubId },
};
emit(`package-${packageId}`, atHub);
// FLOW-02 DELTA (re-stage): pendingBySpoke.get(destSpokeOf(packageId))!.push(packageId);
```

**Dispatch switch — add the new variant** (`engine.ts:1635-1666`; the over-carry case is at `1663-1665`):
```typescript
function dispatch(task: SimTask): void {
  switch (task.kind) {
    case "createPackageBatch": createPackageBatch(task.tick); return;
    case "inductPackage": inductPackage(task.tick); return;
    case "departTrailer": departTrailer(task.trailerId, hubById.get(task.spokeHubId)!, task.departTick); return;
    // ... arriveTrailer, midLegStops ...
    case "arriveOverCarriedAtCenter":
      arriveOverCarriedAtCenter(task.trailerId, task.packageId, task.tripId);
      return;
    // FLOW-02 DELTA: case "arriveConsolidationAtCenter": arriveConsolidationAtCenter(...); return;
  }
}
```

**`SimTask` union — add the DATA variant (never a closure)** (`continuation.ts:50-55`, the over-carry variant):
```typescript
| {
    readonly kind: "arriveOverCarriedAtCenter";
    readonly trailerId: string;
    readonly packageId: string;
    readonly tripId: string;
  };
// FLOW-02 DELTA: a parallel `arriveConsolidationAtCenter` variant carrying packageIds: readonly string[]
```

**`center = hubs[0]!`** (`engine.ts:625`, confirmed) — exported as `MEMPHIS` from `packages/simulation/src/network/hubs.ts:28`.

---

### Concern 3 — `consolidationEnabled` opt-in flag (SimulateOptions + engine.ts)

**Role:** config flag (the determinism template) · **Data flow:** gate (boolean → zero-effect-when-off)
**Analog:** `inductionEnabled` on `SimulateOptions` (`engine.ts:281`, confirmed) + the gate-construction `inductionOn` (`engine.ts:492`, confirmed). Mirror the verbatim shape — every prior opt-in feature (RFID, over-carry, HOS, fuel, induction) uses it.
**Delta:** add `readonly consolidationEnabled?: boolean;` to `SimulateOptions` (default FALSE); construct `const consolidationOn = opts.consolidationEnabled === true;`; gate every consolidation site with `if (!consolidationOn) return;`. The OFF path makes ZERO new RNG draws and emits ZERO new events.

**Flag declaration** (`engine.ts:270-281`, the `inductionEnabled` JSDoc + field):
```typescript
/**
 * IND-02: OPT-IN external package induction at spoke hubs. **DEFAULT FALSE —
 * the determinism keystone.** When absent or `false`, the engine emits NO
 * `PackageInducted` events and makes ZERO `inductionRng` draws ... so the
 * existing seed-1234 + seed-42 goldens are BYTE-IDENTICAL (DET-01). ...
 */
readonly inductionEnabled?: boolean;
```

**Gate construction** (`engine.ts:489-492`, the `inductionOn` derivation):
```typescript
// v2.0 IND-02: external induction is OPT-IN and DEFAULT OFF. Absent/false ⇒ the
// engine emits NO `PackageInducted` and NEVER constructs/draws `inductionRng`,
// so all existing goldens are byte-identical (the determinism keystone).
const inductionOn = opts.inductionEnabled === true;
// CONSOLIDATION DELTA: const consolidationOn = opts.consolidationEnabled === true;
```

**Seed-the-schedule gate** (`engine.ts:1686-1691`, induction's `if (inductionOn)` seed — consolidation does NOT need a fresh-run seed since departures ride the existing `departTrailer` re-dispatch cadence):
```typescript
if (inductionOn) {
  schedule(INDUCTION_START_TICK, { kind: "inductPackage", tick: INDUCTION_START_TICK });
}
```

**API sim-driver threading:** the flag is threaded through `@mm/api`'s sim driver (kept OFF for goldens). Search the API composition root for where `inductionEnabled`/`SimulateOptions` is passed to `simulate()`/`runToHorizon()` and add `consolidationEnabled` alongside it.

---

### Concern 4 — `PlanSuperseded` closed-union event (5-file ceremony + 11 reducers)

**Role:** domain event · **Data flow:** transform (validate) + event-driven (fold)
**Analog:** the Phase-20 `PackageInducted` 5-file ceremony. NET-NEW event (verified: zero `PlanSuperseded` matches in the repo), but the ceremony is mechanical. Closest payload shape: `planAcceptedSchema` (carries the idempotency keys).
**Delta:** replicate the ceremony for ONE new member. Payload must carry **holistic scope state** (D-21-1) so the reducer wipes stale `staged` (per A1 the exact fields are a planning choice; ceremony is what matters).

**Step 1 — `schemas.ts`: the `eventSchema` factory applies `.strict()` automatically** (`schemas.ts:35-44`, confirmed):
```typescript
function eventSchema<TType extends string, TShape extends z.ZodRawShape>(
  type: TType,
  payload: z.ZodObject<TShape>,
) {
  return z.object({
    type: z.literal(type),
    schemaVersion,            // z.literal(EVENT_SCHEMA_VERSION) — rejects unsupported versions
    payload: payload.strict(), // rejects extra fields (T-01-05)
  });
}
```
Payload template — mirror `planAcceptedSchema` (`schemas.ts:230-239`, confirmed):
```typescript
export const planAcceptedSchema = eventSchema(
  "PlanAccepted",
  z.object({ epochId: id, scopeHash: id, planId: id, trailerId: id, occurredAt }),
);
// PlanSuperseded DELTA: add planSupersededSchema (priorPlanId/epochId/scopeHash + holistic scope + reason).
```
Add it to the `discriminatedUnion` (`schemas.ts:422-450`; `packageInductedSchema` is the last member at `:449`):
```typescript
export const domainEventSchema = z.discriminatedUnion("type", [
  // ... 22 existing members ...
  packageInductedSchema,   // ← v2.0 IND-01; add planSupersededSchema after this
]);
```

**Step 2 — `domain-event.ts`: type + union member** (`domain-event.ts:144` type, `:152-179` union; `PackageInducted` is the last member at `:179`):
```typescript
export type PackageInducted = z.infer<typeof packageInductedSchema>;
// PlanSuperseded DELTA: export type PlanSuperseded = z.infer<typeof planSupersededSchema>;

export type DomainEvent =
  | HubRegistered
  // ... all 22 members ...
  | PackageInducted;   // ← add `| PlanSuperseded`
```

**Step 3 — `contract.assert.ts`: the BUILD GATE** (`contract.assert.ts:25-54`; `PackageInducted` case at `:49`). Omitting the case fails `pnpm build` (this is in `src/`, compiled by `tsc -b`, not a test):
```typescript
function assertExhaustive(event: DomainEvent): void {
  switch (event.type) {
    // ... all cases ...
    case "PackageInducted":
      return;       // ← add `case "PlanSuperseded":` before this return
    default:
      assertNever(event);
  }
}
```

**Step 4 — barrel exports** (`events/index.ts:28` type, `:57` schema; `index.ts:80`/`:109`). Mirror `PackageInducted`/`packageInductedSchema` exactly:
```typescript
// events/index.ts — type re-export block (ends ...PackageInducted,) at :28
// events/index.ts — schema re-export block (ends ...packageInductedSchema,) at :57
// src/index.ts — :80 (type) and :109 (schema)
```

**Step 5 — round-trip + strict-reject test** (mirror `plan-events.test.ts`, 178 lines; round-trip `:87-96`, strict-reject `:159-167`, unsupported-version `:169-175`):
```typescript
it("round-trips a well-formed PlanAccepted as a typed event", () => {
  const parsed = validateEvent(planAccepted);
  expect(parsed.type).toBe("PlanAccepted");
});
it("rejects a PlanAccepted with an extra (unrecognized) field — strict payload", () => {
  expect(() => validateEvent({ type: "PlanAccepted", schemaVersion: 1, payload: { /* + extra */ } }))
    .toThrow(ValidationError);   // ValidationError from ingestion/validate.ts (validateEvent at :51)
});
```

**The 11 reducers' exhaustiveness pattern** — `assertNeverEvent` (`reducers/reducer.ts:37`) is the `default` in every reducer. Adding `PlanSuperseded` to the union makes `pnpm build` fail until all 11 reducers handle it. The 11 reducers using the closed switch: `hub-inventory`, `package-location`, `trailer-state`, `zone-estimate`, `driver-status`, `driver-assignment`, `trailer-fuel`, `tag-registry`, `exceptions`, `geo-track`, `audit-timeline`. **10 of them add `case "PlanSuperseded": return state;`** (no-op) to the no-op group. ONLY `hub-inventory.ts` folds it (concern below).

---

### Concern 4b — hub-inventory `staged` supersession reducer (D-21-1 delete-then-apply)

**Role:** reducer · **Data flow:** event-driven (fold, pure)
**Analog:** `packages/projections/src/reducers/hub-inventory.ts` (read in full). The `staged` bucket (`:35`), the unload-scan staging path (`bucketForScan` `"unload" → "staged"` at `:143-144`), the `PlanAccepted` no-op (`:212`), and the deterministic remove helpers (`withoutPackage` `:80-87`, `placePackage` `:106-132`).
**Delta:** D-21-1 mandates a DUMB pure **delete-then-apply** reducer driven by the explicit `PlanSuperseded` event — never an epoch/scope comparison inside the projector.

**DESIGN FLAG (Open Q1 / A2 — the single most important FLOW-04 decision):** today `staged` = unload scans (`:143-144`), and `PlanAccepted` is a **no-op** (`:212`) — nothing stages on a plan. The planner MUST reconcile: either (a) repurpose `staged` so `PlanAccepted` stages and `PlanSuperseded` un-stages (a behavior change), or (b) target a separate plan-staging concept. Research recommends (a) + a regression test that the unload-scan staging still works for non-plan freight. The supersession MECHANISM is locked; the TARGET projection is the open decision.

**The `staged` bucket + remove primitive to reuse:**
```typescript
// hub-inventory.ts:35 — the bucket
export type InventoryBucket = "inbound" | "outbound" | "staged";

// hub-inventory.ts:143-144 — the CURRENT staging path (unload scan, NOT plan-staged today)
case "unload":
  return "staged";

// hub-inventory.ts:80-87 — the deterministic per-package remove the delete-then-apply reuses
function withoutPackage(hub: HubInventory, packageId: string): HubInventory {
  return {
    hubId: hub.hubId,
    inbound: hub.inbound.filter((id) => id !== packageId),
    outbound: hub.outbound.filter((id) => id !== packageId),
    staged: hub.staged.filter((id) => id !== packageId),
  };
}

// hub-inventory.ts:211-212 — PlanAccepted is a NO-OP today (the supersession site)
case "PlanGenerated":
case "PlanAccepted":     // ← FLOW-04: PlanAccepted may begin staging; PlanSuperseded wipes the prior scope
  return state;
```
The `TrailerDeparted` manifest-decrement (`:185-196`) shows the exact `.reduce(placePackage(..., null))` delete pattern to mirror for a holistic-scope wipe.

---

### Concern 5 — `optimizer_idempotency` Postgres table (durable epoch claim)

**Role:** migration/schema + service shell · **Data flow:** CRUD (claim epoch) + event-driven (co-commit `PlanSuperseded`)
**Analog:** the `projection_checkpoints` table (`event-store/src/schema.sql:37-40`, confirmed) + the byte-identical embedded copy (`schema.ts:112-115`) + the `migrate()` runner (`migrate.ts:11`) + the `pg-fixture.ts` Testcontainers path. Replaces the in-memory `LruMap` (`rolling-service.ts:94`).
**Delta:** add `CREATE TABLE IF NOT EXISTS optimizer_idempotency (...)` to BOTH `schema.sql` AND `schema.ts` (the `schema-sql.test.ts` byte-identity test fails otherwise), plus the table to the `Database` interface (`schema.ts:62-67`). Claim via `INSERT ... ON CONFLICT DO NOTHING RETURNING` with a `status` column. Emit `PlanSuperseded` in the SAME `appendPlan` batch as `PlanAccepted`.

**There is NO migration runner** — `migrate()` applies the WHOLE `SCHEMA_SQL` once; every statement is idempotent `CREATE TABLE IF NOT EXISTS`:
```typescript
// event-store/src/migrate.ts:10-12 (confirmed)
export async function migrate(db: Kysely<Database>): Promise<void> {
  await sql.raw(SCHEMA_SQL).execute(db);
}
```

**DDL template** — `projection_checkpoints` (`schema.sql:37-40`, confirmed). Add the new table after it in BOTH files:
```sql
CREATE TABLE IF NOT EXISTS projection_checkpoints (
  projection TEXT   PRIMARY KEY,
  last_seq   BIGINT NOT NULL DEFAULT 0
);
-- DELTA (Google-consult item 4 hardening): UNIQUE(horizon_start, horizon_end, scope_hash) + status column
-- CREATE TABLE IF NOT EXISTS optimizer_idempotency (
--   horizon_start BIGINT NOT NULL, horizon_end BIGINT NOT NULL, scope_hash TEXT NOT NULL,
--   status TEXT NOT NULL DEFAULT 'PROCESSING', plan_id TEXT,
--   claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ,
--   CONSTRAINT uq_optimizer_idempotency UNIQUE (horizon_start, horizon_end, scope_hash)
-- );
```
**Byte-identity guard** (`schema-sql.test.ts`): `expect(SCHEMA_SQL).toBe(fileContents)` — the embedded `SCHEMA_SQL` (`schema.ts:76-125`) must match `schema.sql` exactly. Add the table to BOTH in the same task.
**Kysely `Database` interface** (`schema.ts:62-67`): add an `OptimizerIdempotencyTable` interface + `optimizer_idempotency:` field (mirror `ProjectionCheckpointsTable` at `:47-50`).

**The in-memory `LruMap` it replaces** (`rolling-service.ts:94`, confirmed; the `LruMap` is `packages/api/src/optimizer/lru-map.ts`, 55 LOC):
```typescript
// rolling-service.ts:88-94 — the memo to replace with the durable table
private readonly memo = new LruMap<string, EpochResult>(500);   // CONT-04c, lost on restart (v1.0 debt)
```
**The atomic-append site where `PlanSuperseded` co-commits** (`rolling-service.ts:179-192`, confirmed — `appendWithRetry` is the optimistic-concurrency multi-event writer):
```typescript
private async appendPlan(
  generated: PlanGenerated["payload"],
  accepted: PlanAccepted["payload"],
): Promise<void> {
  const stream = planStreamId(accepted.trailerId);
  const events: readonly DomainEvent[] = [
    { type: "PlanGenerated", schemaVersion: 1, payload: generated },
    { type: "PlanAccepted", schemaVersion: 1, payload: accepted },
    // DELTA: { type: "PlanSuperseded", schemaVersion: 1, payload: superseded }  ← same atomic batch
  ];
  await appendWithRetry(this.db, stream, () => events, new Date(accepted.occurredAt));
}
```
The idempotency `runOnce` memo-check (`rolling-service.ts:142-152`) is the spot the durable claim replaces: `const key = ${epoch.epochId}:${fresh.scopeHash}` then `if (memoized !== undefined) return { ..., committed: false }`.

**Test path:** `startPgFixture()` (`event-store/test/pg-fixture.ts`) — Testcontainers `postgres:17` (or `MM_PG_URL`/`DATABASE_URL`); `migrate(db)` is called at `:48` (shared-server) and `:83` (container). BOUND the int test to one epoch + one simulated restart (GATE-HYGIENE).

**Open Q2 / A5:** `horizon_start/end` columns vs `epochId` — research recommends keying on the scope horizon (`scope.horizonStartMin`/`horizonEndMin`) + `scope_hash` so a restart at the same sim-time re-claims the same row. Confirm in planning.

---

### Concern 6 — scopeHash `ORDER BY` fix (twin-snapshot.ts)

**Role:** read adapter · **Data flow:** request-response (projection SELECT → scopeHash input)
**Analog:** `packages/api/src/optimizer/twin-snapshot.ts:417-424` (anchor was 418-419; the parallel read block spans `:417-424`) vs `freeze-idempotency.ts` `canonicalize`/`scopeHash`.
**Delta:** add explicit `.orderBy(...)` to the projection SELECTs over a stable key (`hub_id`, `trailer_id`). `canonicalize` (`freeze-idempotency.ts:26`) sorts object KEYS but PRESERVES array order — so the SQL read order is load-bearing. With BOTH directions populating `hub_inventory`, an unordered read returns rows in arbitrary physical order across restarts ⇒ `scopeHash` differs ⇒ a frozen epoch re-fires.

**The missing-ORDER-BY reads** (`twin-snapshot.ts:417-424`, confirmed):
```typescript
const [trailerRows, hubInventoryRows, driverStatusRows] = await Promise.all([
  db.selectFrom("trailer_state").selectAll().execute(),       // ← NO ORDER BY — add .orderBy("trailer_id")
  db.selectFrom("hub_inventory").selectAll().execute(),       // ← NO ORDER BY — add .orderBy("hub_id")
  db
    .selectFrom("driver_status")
    .select(["driver_id", "remaining_drive_minutes", "hos_clock"])
    .execute(),                                               // ← consider .orderBy("driver_id") too
]);
```

**Why order matters** (`freeze-idempotency.ts:25-36`, `canonicalize` — confirmed it `value.map(canonicalize)` on arrays, sorting keys only):
```typescript
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);   // ← array ORDER preserved (not sorted)
  if (value !== null && typeof value === "object") {
    // object KEYS recursively sorted ...
  }
  return value;
}
```
**Anti-pattern (REJECTED):** `SELECT *`/physical-order reads feeding `scopeHash`. The freeze-window boundaries must align exactly across the added direction (Google-consult item 5).

---

### Concern 7 — `is_active` detection scoping (detector.ts)

**Role:** projection read adapter · **Data flow:** request-response (bounded query)
**Analog:** `packages/projections/src/detector.ts` — `runDetection` (`:120-148`, confirmed: no active filter) and `makeProjectionReads` (`:165+`) whose `selectAll()` reads scan all-ever.
**Delta:** NET-NEW (verified: zero `is_active` matches). Add an active predicate/column and scope the `makeProjectionReads` queries to active packages. The planner chooses WHERE the active flag lives (a column on `package_location`/`zone_estimate`, or a "not yet arrived at final dest" predicate). Benchmark at a BOUNDED state size (~1-5k packages, NOT 10k — GATE-HYGIENE).

**The unscoped scans to bound** (`detector.ts:174, 186, 205`, confirmed):
```typescript
// detector.ts:174 — PLANNED layer (full trailer_state scan)
const trailers = await db.selectFrom("trailer_state").selectAll().execute();
// detector.ts:186 — OBSERVED layer (full zone_estimate scan)
const rows = await db.selectFrom("zone_estimate").selectAll().execute();
// detector.ts:205 — departed-hubs gate (full trailer_state scan again)
const trailers = await db.selectFrom("trailer_state").selectAll().execute();
```
`runDetection` (`:120`) itself reads four ports in parallel (`:124-129`); the scoping lives in the `makeProjectionReads` adapter (`:165`) so the pure detection core is untouched.

---

### Concern 8 — VIZ-12 `direction` field (envelope.ts + snapshots.ts + web map)

**Role:** wire DTO + snapshot builder + map style · **Data flow:** streaming (server→client diff) + rendering
**Analog:** `TrailerKeyframe` optional `util` field (`envelope.ts:47-59`) + `trailerChanged` diff (`envelope.ts:274-282`) + the `routeId = legRouteId(from,to)` derivation (`snapshots.ts:303-307`) + `InflightLeg` (`snapshots.ts:276-279`) + the web `trailerStyle` StyleFunction (`coloring.ts:267-274`) + `upsertTrailerKeyframe` (`layers.ts:148-175`) + `inductionColoring.ts` (the VIZ-13 style precedent).
**Delta:** add `direction: 'outbound' | 'consolidation'` to `TrailerKeyframe` as **optional + additive** (back-compat, like `util`/`TrailerStop`); derive `direction = from_hub_id === MEMPHIS.hubId ? 'outbound' : 'consolidation'` in `buildTrailerKeyframes`; add it to `trailerChanged`; thread it through `upsertTrailerKeyframe` feature props; key a distinct trailer style on it.

**`TrailerKeyframe` — add the optional field** (`envelope.ts:47-59`, confirmed):
```typescript
export interface TrailerKeyframe {
  readonly id: string;
  readonly routeId: string;
  readonly departMs: number;
  readonly etaMs: number;
  readonly state: "onTime" | "slaRisk" | "late" | "idle";
  readonly util?: number;   // ← optional+additive precedent; add `readonly direction?: 'outbound' | 'consolidation';`
}
```

**`trailerChanged` — add the comparison so a direction change re-emits** (`envelope.ts:274-282`, confirmed):
```typescript
function trailerChanged(prev: TrailerKeyframe, next: TrailerKeyframe): boolean {
  return (
    prev.routeId !== next.routeId ||
    prev.departMs !== next.departMs ||
    prev.etaMs !== next.etaMs ||
    prev.state !== next.state ||
    prev.util !== next.util        // ← add `|| prev.direction !== next.direction`
  );
}
```

**Derive from the leg** (`snapshots.ts:303-307`, confirmed; `InflightLeg.from_hub_id` at `:276-279`):
```typescript
const routeIdByTrip = new Map<string, string>();
for (const trip of inflightTrips) {
  routeIdByTrip.set(trip.trip_id, legRouteId(trip.from_hub_id, trip.to_hub_id));
  // VIZ-12 DELTA: directionByTrip.set(trip.trip_id, trip.from_hub_id === MEMPHIS.hubId ? 'outbound' : 'consolidation')
}
// then set keyframe.direction at the construction sites (snapshots.ts:335-350)
```

**Web map style — mirror `trailerStyle`** (`coloring.ts:267-274`, confirmed; reads `feature.get("state")` from a pre-allocated cache):
```typescript
export function trailerStyle(feature: FeatureLike): Style {
  const state: unknown = feature.get("state");
  if (typeof state === "string") {
    const cached = TRAILER_STYLE_CACHE.get(state);
    if (cached !== undefined) return cached;
  }
  return TRAILER_STYLE_DEFAULT;
}
// VIZ-12 DELTA: also branch on feature.get("direction") for a distinct consolidation color/arrow.
```
**`upsertTrailerKeyframe` — thread the prop** (`layers.ts:148-175`, confirmed; `existing.set("state", ...)` at `:159`, new-Feature props at `:164-171`):
```typescript
existing.set("state", keyframe.state);
if (keyframe.util !== undefined) existing.set("util", keyframe.util);
// VIZ-12 DELTA: if (keyframe.direction !== undefined) existing.set("direction", keyframe.direction);
```
**Style precedent for a NEW direction-keyed style:** `inductionColoring.ts` (the VIZ-13 module) — ONE pre-allocated `Style` at module load, zero-per-frame allocation (`:24-32`), a StyleFunction returning the cached reference (`:39-41`), wired into `layers.ts:13` (`import { inductionStyle }`). The VIZ-12 layer test mirrors `packages/web/src/map/inductionLayer.test.ts`.

---

### Concern 9 — FLOW-05 (P2) hub balance panel (hub-detail.ts + web panel)

**Role:** read API route + UI panel · **Data flow:** request-response
**Analog:** `packages/api/src/routes/hub-detail.ts` (the `GET /hubs/:id/detail` route, read in full — registration `:200-323`, projection reads `:214-230`) + `packages/web/src/panels/MoneySlide.tsx` (fetch + pure exported helpers).
**Delta:** add inbound/outbound balance (cross-dock heat) to the hub read API surfacing `hub_inventory` counts, + a web panel widget. Lowest priority (P2).

**The read-API route pattern** (`hub-detail.ts:200-230`, confirmed — pure read over projections, no writes; mirrors `queries.ts`/`plan-detail.ts`):
```typescript
export function registerHubDetailRoutes(app: FastifyInstance, db: ApiDb, timing = DEFAULT_TIMING_CONFIG): void {
  app.get<{ Params: IdParams }>(
    "/hubs/:id/detail",
    { schema: { params: idParamsSchema } },
    async (req): Promise<HubDetailDto> => {
      const hubId = req.params.id;
      const [trailerRows, /* ... */] = await Promise.all([
        db.selectFrom("trailer_state").selectAll().where("current_hub_id", "=", hubId).execute(),
        // FLOW-05 DELTA: read hub_inventory inbound/outbound counts for the balance widget
      ]);
      // ... assemble + return { hubId, trailers } (P3: stable id-sorted output)
    },
  );
}
```
FLOW-05 reads the SAME `hub_inventory` projection the optimizer consumes (Decision 3). The DTO discipline: explicit `readonly` wire shape (`HubDetailDto` at `:91-95`), stable id-sorted ordering (`:316-318`), valid-empty answer for an unseen hub (`:232-234`).

**The web panel pattern** (`MoneySlide.tsx:24-55`, confirmed — `fetch` via `../api/client.js` + exported PURE helpers that are unit-tested, React 19, strict TS no `any`):
```typescript
import { useState, useEffect } from "react";
import { fetchKpiComparison } from "../api/client.js";
// Pure exported helpers (formatDelta, winClass, comparisonRows) are unit-tested separately
export function formatDelta(field: ScoreField, delta: number): string { /* ... */ }
```

---

## Shared Patterns

### Opt-in feature flag (the determinism keystone — applies to ALL engine changes)
**Source:** `packages/simulation/src/engine.ts:281` (`inductionEnabled` field), `:492` (`inductionOn` gate).
**Apply to:** every consolidation site in `engine.ts`. The OFF path makes ZERO new RNG draws and emits ZERO new events.
```typescript
readonly consolidationEnabled?: boolean;          // SimulateOptions, DEFAULT FALSE
const consolidationOn = opts.consolidationEnabled === true;
// every site: if (!consolidationOn) return;
```

### Continuation capture (applies to ALL new engine world-state)
**Source:** `continuation.ts:80-99` (`SerializedWorldState` tuple-array), `engine.ts:1722-1741` (`captureContinuation`), `engine.ts:966-972` (restore).
**Apply to:** `pendingAtSpoke` + the `arriveConsolidationAtCenter` `SimTask` variant. New event sources MUST add a DATA variant (never a closure) or the run is not resumable.

### Atomic multi-event append (applies to `PlanSuperseded` co-commit)
**Source:** `rolling-service.ts:191` — `appendWithRetry(this.db, stream, () => events, occurredAt)`. Handles optimistic-concurrency `ConcurrencyError` retry + per-stream versioning. The rolling shell is the ONLY side-effecting writer.

### Closed-union exhaustiveness (applies to `PlanSuperseded` everywhere)
**Source:** `contract.assert.ts:25-54` (`assertExhaustive` → `assertNever`) + `reducers/reducer.ts:37` (`assertNeverEvent`). The build fails until the contract + all 11 reducers handle the new member — the build is the primary witness.

### Idempotent whole-schema migration (applies to `optimizer_idempotency`)
**Source:** `migrate.ts:11` (`sql.raw(SCHEMA_SQL).execute(db)`) + `schema-sql.test.ts` (byte-identity guard). Append `CREATE TABLE IF NOT EXISTS` to BOTH `schema.sql` and `schema.ts`; add the Kysely interface to `Database`.

### Zero-allocation OL StyleFunction (applies to VIZ-12 direction styling)
**Source:** `coloring.ts:249-274` (pre-allocated `TRAILER_STYLE_CACHE` + `trailerStyle`) and `inductionColoring.ts:24-41`. Pre-allocate Styles at module load; the StyleFunction returns a cached reference (P10 / T-01-24 leak guard).

### Canonical idempotency hash (applies to scopeHash ORDER BY)
**Source:** `freeze-idempotency.ts:44` (`scopeHash`) + `:25-36` (`canonicalize`). Do NOT build a new hash; only fix the SQL read ORDER (array order is load-bearing; keys are already sorted).

### Ephemeral Postgres for int tests
**Source:** `event-store/test/pg-fixture.ts` (`startPgFixture()` → Testcontainers `postgres:17` / `MM_PG_URL` / `DATABASE_URL`, `migrate()` applied). Use for the durable-idempotency + supersession int tests; BOUND to one epoch + one restart.

---

## No Analog Found

None. Every concern has an in-repo, tested precedent. The two artifacts that did not previously EXIST (`PlanSuperseded`, `optimizer_idempotency`) are net-new but each has a direct, mechanical TEMPLATE (the `PackageInducted` ceremony and the `projection_checkpoints` table + `migrate()`), so they are classified as exact-match-via-template, not "no analog." The `is_active` predicate is net-new (no column/predicate exists today) but the read-scoping lives in an existing adapter (`makeProjectionReads`) — role-match.

| Concern | Why net-new | Template to copy |
|---------|-------------|------------------|
| `PlanSuperseded` event | No supersession event exists (verified: 0 matches) | `PackageInducted` 5-file ceremony |
| `optimizer_idempotency` table | No durable idempotency store exists (verified: 0 matches) | `projection_checkpoints` DDL + `migrate()` |
| `is_active` scoping | No active column/predicate exists (verified: 0 matches) | `makeProjectionReads` query adapter |

---

## Metadata

**Analog search scope:** `packages/simulation/{src,test}`, `packages/domain/src/events`, `packages/projections/src/reducers` + `detector.ts`, `packages/event-store/{src,test}`, `packages/optimizer/src/rolling`, `packages/api/src/{optimizer,ws,routes}`, `packages/web/src/{map,panels}`.
**Files read this session:** 22 source files + 2 upstream artifacts (CONTEXT.md, RESEARCH.md). All RESEARCH.md line anchors re-verified against actual source; drift noted inline (e.g. twin-snapshot read block is `417-424`, capture field is `1724-1726`).
**Net-new artifacts confirmed absent:** `grep -rn "optimizer_idempotency|PlanSuperseded|is_active"` → 0 matches.
**Pattern extraction date:** 2026-06-24.
