# Phase 21: Bidirectional Freight / Consolidation - Research

**Researched:** 2026-06-24
**Domain:** Deterministic, event-sourced discrete-event logistics simulation (TS/Node pnpm monorepo `@mm/*`)
**Confidence:** HIGH (every claim grounded in line-level reads of the actual codebase, verified this session)

## Summary

Phase 21 is the highest-integration phase of v2.0. It makes spoke→center **consolidation** trailers carry real freight (`pendingAtSpoke`), the center re-sort that freight (inbound unload → re-stage for onward distribution), and the optimizer treat both flow directions without double-counting. The keystone is **determinism integrity**: with `consolidationEnabled:false` (default) the existing goldens (`determinism.unit.test.ts` seed-1234@6000 and seed-42@10000 → `3920accc…`) must stay byte-identical; with it on, a chunked-via-continuation run must be byte-identical to all-at-once (`continuation-equivalence.unit.test.ts`).

The codebase is exceptionally well-architected for this change: every prior opt-in feature (RFID, over-carry, HOS, fuel, induction) follows the **exact same template** — a flag on `SimulateOptions` (off by default), a dedicated structure captured in `SimContinuation.world`, a self-rescheduling `EventQueue` task (DATA, never a closure) added to the `SimTask` union, and a paired determinism test. Phase 21's `pendingAtSpoke` mirrors `pendingBySpoke` exactly. The **over-carry return-leg** (`engine.ts:1503-1547`) is a working spoke→center departure + center re-arrival already in the code — it is the literal precedent for FLOW-01/FLOW-02/FLOW-03, minus the over-carry rate draw.

The two genuinely net-new pieces are: (1) the `PlanSuperseded` closed-union event (D-21-1 RESOLVED — full 5-file ceremony + all 11 reducers), emitted by `RollingOptimizerService.appendPlan` in the SAME atomic append as `PlanAccepted`; and (2) the `optimizer_idempotency` Postgres table replacing the in-memory `LruMap`. **Both are new because neither a supersession event nor a durable idempotency store exists today** — verified by grep (zero matches for `optimizer_idempotency`, `PlanSuperseded`, `is_active`).

**Primary recommendation:** Treat Phase 21 as five thin additive deltas, each mirroring an existing, tested pattern: `pendingAtSpoke` mirrors `pendingBySpoke`; the consolidation departure/re-sort mirrors the over-carry return leg; `PlanSuperseded` mirrors the `PackageInducted` 5-file ceremony (Phase 20); `optimizer_idempotency` mirrors the `projection_checkpoints` table + `migrate()` mechanism; VIZ-12 `direction` mirrors the `routeId = route-FROM-TO` derivation. **NO new RNG is required** (consolidation reuses existing freight — confirmed below). Every new continuation/Postgres test must be bounded (≤500–800 ticks, single equivalence case) per GATE-HYGIENE.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **`pendingAtSpoke` two-queue model** — add `pendingAtSpoke: Map<spokeHubId, string[]>` alongside the existing `pendingBySpoke` (center→spoke). Spoke→center consolidation trailers drain `pendingAtSpoke`; distribution trailers drain `pendingBySpoke`. **Empty `pendingAtSpoke` is VALID** (a return leg with no consolidation freight departs/returns without error).
- **Spoke→spoke via center** (Decision 2) — cross-spoke freight routes Spoke A → Center → Spoke B; existing star topology + time-expanded graph. The center **inbound unload + re-sort** handles spoke→center arrivals.
- **Optimizer reads demand via the existing `hub_inventory` projection** (Decision 3) — both directions surface as inbound/staged inventory; no new twin demand concept.
- Reverse routes already registered at bootstrap (Phase 19) — no new ORS call.
- **D-21-1 → RESOLVED: explicit `PlanSuperseded` event** (Google AI Mode consult, 2026-06-24). The optimizer emits `PlanSuperseded(priorPlanId/epoch+scope, reason)` in the SAME commit as the new `PlanAccepted`; the staged-projection reducer stays a dumb pure **delete-then-apply**. The superseding event MUST carry **holistic scope state** (or the reducer wipes all `staged` for that scope where `state.epoch < event.epoch`) so items present in the OLD plan but absent in the NEW are wiped, not stranded.

### Determinism keystone (LOCKED — CRITICAL)
- **`pendingAtSpoke` MUST be captured in `SimContinuation.world`** exactly like `pendingBySpoke` (engine.ts:1724) so a chunked/continuous run is byte-identical. Add a continuation-equivalence case with `consolidationEnabled:true` crossing a chunk boundary mid-consolidation.
- **Opt-in:** `consolidationEnabled: false` (default) ⇒ ZERO new behavior ⇒ seed-1234 + seed-42 (`3920accc…`) goldens byte-identical. Empty returns must not appear when off.
- Deterministic same-tick tie-break preserved; consolidation scheduling via the `EventQueue` (no external append).
- **No new RNG draws** if consolidation reuses existing freight — confirmed in this research (see "RNG Decision"); if any new randomness, it needs a salted substream carried in the continuation.

### Google AI Mode consult — net-new items folded into gates (LOCKED)
1. **Double-drain prevention:** deterministic sort key on `pendingAtSpoke` (`[priority]+[timestamp/tick]+[unique freight id]`); atomic peek+pop (splice the manifest in one step); sort idle trailers by `trailerId` before draining; evaluate one-by-one.
2. **Empty-return guard:** allow an empty return only past a deterministic threshold (don't silently emit empty returns).
3. **Slot-race guard:** an empty-return and a freight-leg must not race the SAME center slot in one tick — order consolidation departures and distribution arrivals at the center deterministically.
4. **Durable idempotency hardening:** `optimizer_idempotency` table = `UNIQUE(horizon_start, horizon_end, scope_hash)` + `INSERT ... ON CONFLICT ... RETURNING` to atomically claim an epoch; add a `status` column (PROCESSING/COMPLETED/FAILED) for crash-mid-epoch recovery; the **scopeHash MUST use explicit `ORDER BY`** over BOTH directions' inputs (never `SELECT *`/physical order) — the new inbound/consolidation rows must be IN the hash.
5. Freeze-window boundaries must align exactly across the added direction.

### Claude's Discretion
- Consolidation cadence / which spokes consolidate / freight selection — deterministic; tuned for a watchable demo without starving distribution.
- VIZ-12 direction styling (consolidation vs distribution trailer color/arrow).

### Deferred Ideas (OUT OF SCOPE)
- Outbound delivery / `PackageDelivered` (Phase 22).
- Returns/reverse-logistics as a distinct third flow direction (FLOW-FUT-01).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FLOW-01 | Spoke→center consolidation freight flows — spoke-origin trailers depart carrying real freight drained from a new `pendingAtSpoke` manifest queue (reverse routes registered at bootstrap; no ORS call). | `pendingAtSpoke` mirrors `pendingBySpoke` (engine.ts:966-972, capture 1724); spoke-origin `TrailerDeparted` already proven by the over-carry return leg (engine.ts:1513-1524). |
| FLOW-02 | Center receives + re-sorts spoke→center arrivals (inbound unload), enabling Spoke A → Center → Spoke B routing. | Mirror `arriveOverCarriedAtCenter` (engine.ts:1581-1613): unload scan + `PackageArrivedAtHub` at center → re-stage into `pendingBySpoke[destSpoke]` for onward distribution. |
| FLOW-03 | Center→spoke distribution continues unbroken (regression-safe); empty-return legs remain valid. | DET-01 flags-off gate (determinism.unit.test.ts:194-208); empty-manifest departure is the default over-carry-off path. |
| FLOW-04 | Optimizer aware of both directions — scope + travel model handle spoke→center legs; consolidation not double-counted (stale `staged` cleared via `PlanSuperseded`; idempotency persists across restarts). | `scope.ts` `hubsOf`/`trailersOf` (already direction-agnostic via `fromHubId`/`toHubId`); `freeze-idempotency.scopeHash`; `RollingOptimizerService` memo → Postgres `optimizer_idempotency`; twin-snapshot SELECTs need `ORDER BY` (twin-snapshot.ts:418-419). |
| VIZ-12 | Consolidation trailers render with non-empty manifests + distinct direction styling. | Add `direction: 'outbound' \| 'consolidation'` to `TrailerKeyframe` (envelope.ts:47); derive from `from_hub_id === center` in `buildTrailerKeyframes` (snapshots.ts:303-307). |
| FLOW-05 (P2) | Per-hub inbound/outbound balance display (cross-dock heat). | `hub-detail.ts` route already reads `hub_inventory`; `MoneySlide.tsx`/KPI panel patterns for the UI widget. |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| `pendingAtSpoke` manifest + consolidation departure | `@mm/simulation` engine | `@mm/simulation` continuation | The deterministic event-queue core owns all freight movement; the manifest is world state captured in `SimContinuation`. |
| Center inbound unload + re-sort | `@mm/simulation` engine | — | A new dispatch task (`arriveConsolidationAtCenter`) emits unload + re-stage events; pure engine logic. |
| `consolidationEnabled` flag | `@mm/simulation` `SimulateOptions` | `@mm/api` sim driver | Flag gates the whole feature; the API sim driver threads it through to the live demo (kept off for goldens). |
| `PlanSuperseded` event + validation | `@mm/domain` | `@mm/projections` (11 reducers) | Closed-union membership + Zod `.strict()` belong to the domain contract; reducers fold it. |
| Stale-`staged` supersession | `@mm/projections` hub-inventory reducer | — | A dumb pure delete-then-apply reducer (D-21-1); reducers own read-model state. |
| Optimizer two-direction scope + supersession emit | `@mm/optimizer` (pure) + `@mm/api` `RollingOptimizerService` (shell) | — | Pure `runEpoch` returns payloads; the shell is the ONLY side-effecting writer (appends `PlanAccepted`/`PlanSuperseded`). |
| Durable idempotency (`optimizer_idempotency` table) | `@mm/api` `RollingOptimizerService` | `@mm/event-store` schema/migrate | Side-effecting, restart-surviving state belongs at the shell/DB boundary, not in the pure core. |
| `is_active` detection scoping | `@mm/projections` `detector.ts` + `makeProjectionReads` | — | Detection reads projections; bounding to active packages is a read-query concern. |
| VIZ-12 `direction` field + styling | `@mm/api` ws envelope (`direction`) | `@mm/web` map layers (color) | The wire protocol carries the discriminator; the client renders it (keep the OL map imperatively driven). |
| FLOW-05 inbound/outbound balance | `@mm/api` hub-detail route | `@mm/web` panel | The read API surfaces `hub_inventory` counts; the panel displays them. |

## Standard Stack

**This is a brownfield phase — zero new runtime dependencies.** All work extends existing `@mm/*` packages with their pinned versions. The Standard Stack table below is the relevant *existing* toolchain, version-verified against the npm registry this session.

### Core
| Library | Version (pinned) | Registry latest (2026-06-24) | Purpose | Notes |
|---------|------------------|------------------------------|---------|-------|
| Node.js | 22 LTS (`engines: >=22`; dev box on v23.11) | — | Runtime | `package.json:8` pins `>=22`. |
| TypeScript | 5.9.x | **6.0.3** | Language | Registry `latest` is now a 6.x line — **do NOT bump**; CLAUDE.md mandates pinning 5.9 until 6.0 GA is vetted (would risk invalidating goldens via emit changes). |
| Fastify | 5.8.5 | 5.8.5 | HTTP/WS/read API | FLOW-05 read endpoint + VIZ-12 ws payload. |
| PostgreSQL | 16/17 (tests use `postgres:17` via Testcontainers) | — | Event store + projections | New `optimizer_idempotency` table lives here. |
| Kysely | 0.29.2 | 0.29.2 | Type-safe SQL | The `INSERT ... ON CONFLICT ... RETURNING` for idempotency; `ORDER BY` on twin reads. |
| `pg` | 8.22.0 | 8.22.0 | Postgres driver | Under Kysely. |
| Zod | 4.4.x | 4.4.3 | Schema validation | `PlanSuperseded` `.strict()` schema via the `eventSchema` factory. |
| Vitest | 4.1.x | 4.1.9 | Test runner | All determinism/continuation/round-trip tests. |
| `@testcontainers/postgresql` | (existing) | 12.0.3 | Ephemeral PG for int tests | `pg-fixture.ts` already wired (see Environment Availability). |

### Supporting (existing, no install)
| Library | Purpose | Phase-21 use |
|---------|---------|--------------|
| `@mm/event-store` `appendWithRetry` | Optimistic-concurrency atomic multi-event append | `PlanSuperseded` rides the SAME `appendPlan` batch as `PlanAccepted`. |
| OpenLayers (`ol`) 10.9 | Map rendering | VIZ-12 direction styling in `packages/web/src/map/layers.ts`. |

**Installation:** None. `pnpm install` already satisfies the workspace. Do not add packages.

**Version verification (this session):** `npm view` confirmed fastify 5.8.5, kysely 0.29.2, pg 8.22.0, vitest 4.1.9, zod 4.4.3, @testcontainers/postgresql 12.0.3 — all match CLAUDE.md pins. `npm view typescript version` returns **6.0.3** (a pre/early-6.x line); the project intentionally pins 5.9 — flagged so the planner never "upgrades" it. `[VERIFIED: npm registry]`

## Architecture Patterns

### System Architecture Diagram (Phase-21 data flow)

```
[consolidationEnabled flag]
        │ (off by default ⇒ ZERO new behavior ⇒ goldens byte-identical)
        ▼
┌──────────────────────────── @mm/simulation engine (deterministic EventQueue) ─────────────────────────────┐
│                                                                                                            │
│  inductPackage / center batch ──► pendingAtSpoke[spoke]  (NEW: mirrors pendingBySpoke)                      │
│                                          │                                                                  │
│   departTrailer (spoke→center leg) ──────┘ atomic splice(0,len)  ──► TrailerDeparted(from=spoke,to=center)  │
│        │  (deterministic: sort idle trailers by trailerId; one manifest, one trailer)                      │
│        ▼                                                                                                    │
│   arriveConsolidationAtCenter (NEW task) ──► unload scans + PackageArrivedAtHub@center                      │
│        │                                    └─► RE-STAGE into pendingBySpoke[destSpoke]  (FLOW-02 cross-dock)│
│        ▼                                                                                                    │
│   captureContinuation():  world.pendingAtSpoke  (NEW — byte-identical chunked/continuous)                   │
└───────────────────────────────────────────────────┬────────────────────────────────────────────────────────┘
                                                     │ emit (per-tick appendToStream)
                                                     ▼
┌──────────────── @mm/event-store (append-only log) ───────────────┐    ┌────── @mm/projections ──────┐
│  events table (global_seq total order)                            │──►│ hubInventoryReducer:         │
│  NEW: optimizer_idempotency table (durable epoch claim)           │   │  PackageArrivedAtHub→inbound │
└───────────────────────────────────────┬──────────────────────────┘   │  PlanSuperseded→DELETE staged│
                                         │ readAll / projections          │  (dumb delete-then-apply)    │
                                         ▼                                └──────────────┬───────────────┘
┌──────────────── @mm/api RollingOptimizerService (the ONLY side-effecting writer) ──────┴──────────────────┐
│  runOnce(epoch): runEpoch (pure) → scopeHash                                                              │
│   ├─ claim epoch via optimizer_idempotency (INSERT…ON CONFLICT…RETURNING; status PROCESSING→COMPLETED)    │
│   └─ on accept: appendPlan() appends [PlanGenerated, PlanAccepted, PlanSuperseded] ATOMICALLY (one tx)    │
│  buildTwinSnapshot: SELECT … ORDER BY (NEW) so both directions feed scopeHash deterministically           │
└───────────────────────────────────────┬──────────────────────────────────────────────────────────────────┘
                                         │ buildSnapshotPayload / diffTick
                                         ▼
                          ws TickPayload.trailers[].direction = 'outbound'|'consolidation'  (VIZ-12)
                                         │
                                         ▼  @mm/web map: distinct color/arrow per direction; FLOW-05 hub balance panel
```

### Recommended Project Structure (files Phase 21 touches — all existing)
```
packages/
├── simulation/src/
│   ├── engine.ts            # pendingAtSpoke + consolidation departure/re-sort + consolidationEnabled
│   └── continuation.ts      # SimTask: add arriveConsolidationAtCenter variant; SerializedWorldState: add pendingAtSpoke
│   └── test/
│       ├── consolidation-determinism.unit.test.ts   # NEW (mirror over-carry.unit.test.ts)
│       └── continuation-equivalence.unit.test.ts    # EXTEND: add consolidationEnabled:true case
├── domain/src/events/
│   ├── schemas.ts           # planSupersededSchema (+ add to discriminatedUnion)
│   ├── domain-event.ts      # PlanSuperseded type + union member
│   ├── contract.assert.ts   # add case "PlanSuperseded"
│   ├── index.ts             # export type + schema
│   └── plan-events.test.ts  # EXTEND round-trip + reject tests (or new plan-superseded.test.ts)
├── projections/src/
│   ├── reducers/hub-inventory.ts   # PlanAccepted→stage / PlanSuperseded→delete-then-apply
│   ├── reducers/*.ts (10 others)   # add case "PlanSuperseded": return state  (no-op)
│   └── detector.ts                  # is_active scoping in makeProjectionReads
├── event-store/src/
│   ├── schema.sql + schema.ts      # CREATE TABLE optimizer_idempotency (byte-identical pair)
├── api/src/
│   ├── optimizer/rolling-service.ts # replace LruMap with optimizer_idempotency; emit PlanSuperseded in appendPlan
│   ├── optimizer/twin-snapshot.ts   # add ORDER BY to the projection SELECTs
│   ├── ws/envelope.ts               # TrailerKeyframe.direction + trailerChanged comparison
│   ├── ws/snapshots.ts              # derive direction from from_hub_id===center
│   └── routes/hub-detail.ts         # FLOW-05 inbound/outbound balance (already reads hub_inventory)
└── web/src/
    ├── map/layers.ts                # VIZ-12 direction-keyed trailer style
    └── panels/                      # FLOW-05 hub balance widget (mirror MoneySlide.tsx)
```

### Pattern 1: Opt-in feature flag mirroring existing flags (the determinism template)
**What:** Add `consolidationEnabled?: boolean` to `SimulateOptions`, gated so the OFF path is byte-identical.
**When to use:** The single non-negotiable pattern for every v2.0 feature.
**Example (verbatim shape from the existing `inductionEnabled` / `fuel` gates):**
```typescript
// Source: packages/simulation/src/engine.ts:281 (inductionEnabled) and :241 (runUntilStopped)
readonly consolidationEnabled?: boolean;   // DEFAULT FALSE — the determinism keystone.

// Gate construction exactly like inductionOn (engine.ts:492):
const consolidationOn = opts.consolidationEnabled === true;
// Every consolidation site begins:  if (!consolidationOn) return;  // never runs when off
```
The OFF path must make **zero** new RNG draws and emit **zero** new events — proven by `consolidationEnabled:false ⇒ byte-identical to absent`, exactly like `induction-determinism.unit.test.ts:41-45`.

### Pattern 2: `pendingAtSpoke` mirrors `pendingBySpoke` (two-queue manifest)
**What:** A second per-spoke manifest, drained by spoke→center legs, captured in the continuation.
**Example (the existing `pendingBySpoke` lifecycle — mirror every step):**
```typescript
// Source: packages/simulation/src/engine.ts:966-972 (init + restore-from-continuation)
const pendingBySpoke = new Map<string, string[]>();
if (resuming) {
  for (const [hubId, ids] of start.world.pendingBySpoke) pendingBySpoke.set(hubId, [...ids]);
}
for (const s of spokes) if (!pendingBySpoke.has(s.hubId)) pendingBySpoke.set(s.hubId, []);

// Source: engine.ts:1283-1284 (atomic drain at departure — splice in one step)
const manifest = pendingBySpoke.get(spoke.hubId)!;
const loaded = manifest.splice(0, manifest.length);   // ATOMIC peek+pop (Google-consult double-drain guard)

// Source: engine.ts:1724-1726 (capture into SimContinuation.world)
pendingBySpoke: [...pendingBySpoke.entries()].map(([k, v]) => [k, [...v]] as const),
```
`pendingAtSpoke` adds the identical four touch-points. The Google-consult **double-drain guard** is already satisfied by `splice(0, length)` (atomic). The added discipline: sort idle trailers by `trailerId` before draining (the engine already iterates trailers in stable roster order — `trailerRoster`, engine.ts:946), and use a deterministic sort key on the manifest contents. Note the **existing** `pendingBySpoke` uses FIFO push order; the consult recommends an explicit `[priority]+[tick]+[freightId]` sort — apply it only to `pendingAtSpoke` (do not perturb `pendingBySpoke`'s existing order or goldens shift).

### Pattern 3: Consolidation departure + center re-sort mirrors the over-carry return leg
**What:** A spoke→center `TrailerDeparted` (from=spoke, to=center) + a scheduled center arrival that unloads and **re-stages** for onward distribution.
**This already exists** for over-carry (a single held-back package):
```typescript
// Source: packages/simulation/src/engine.ts:1513-1546 — spoke-origin departure + scheduled center arrival
const returnDeparted: TrailerDeparted = {
  type: "TrailerDeparted", schemaVersion: 1,
  payload: { trailerId, fromHubId: spoke.hubId, toHubId: center.hubId, tripId: returnTripId, packageIds: overCarried },
};
emit(`trailer-${trailerId}`, returnDeparted);
const returnArriveTick = arriveTick + drawTransitTicks(spoke.hubId, center.hubId);
schedule(returnArriveTick, { kind: "arriveOverCarriedAtCenter", trailerId, packageId, tripId: returnTripId });

// Source: engine.ts:1600-1612 — center arrival: unload scan + PackageArrivedAtHub@center
const unload: PackageScanned = { type: "PackageScanned", schemaVersion: 1,
  payload: { packageId, hubId: center.hubId, scanType: "unload" } };
emit(`package-${packageId}`, unload);
const atHub: PackageArrivedAtHub = { type: "PackageArrivedAtHub", schemaVersion: 1,
  payload: { packageId, hubId: center.hubId } };
emit(`package-${packageId}`, atHub);
```
**FLOW-02 delta:** the new `arriveConsolidationAtCenter` task does the same unload + `PackageArrivedAtHub@center`, then **re-stages each package into `pendingBySpoke[destSpoke]`** (the package's `destHubId` — a different spoke per Decision 2) so the existing center→spoke distribution picks it up. This is the cross-dock. Add the new variant to the `SimTask` union (`continuation.ts:27-55`) and a `case` in `dispatch` (`engine.ts:1635-1666`) — the engine already routes `arriveOverCarriedAtCenter` this way.

### Pattern 4: Closed-union event ceremony for `PlanSuperseded` (5 files + reducers)
**What:** Add a new domain event end-to-end. This is the **exact** ceremony Phase 20 used for `PackageInducted` (the "5-file closed-union ceremony" in ROADMAP 20-01-PLAN).
**The five touch-points (all verified):**
1. `packages/domain/src/events/schemas.ts` — add `planSupersededSchema = eventSchema("PlanSuperseded", z.object({...}))` (factory at :35 applies `.strict()` automatically) AND add it to `domainEventSchema` discriminatedUnion (:422-449).
2. `packages/domain/src/events/domain-event.ts` — add `export type PlanSuperseded = z.infer<typeof planSupersededSchema>;` and add `| PlanSuperseded` to the `DomainEvent` union (:152-179).
3. `packages/domain/src/events/contract.assert.ts` — add `case "PlanSuperseded":` to `assertExhaustive` (:26-50). **This is the build gate** — omitting it fails `pnpm build`.
4. `packages/domain/src/events/index.ts` + `packages/domain/src/index.ts` — export the type + schema (mirror `PackageInducted`/`packageInductedSchema` at index.ts:80, :109).
5. A round-trip test (extend `plan-events.test.ts` or new `plan-superseded.test.ts`) — `validateEvent(planSuperseded)` round-trips; `.strict()` rejects an extra field; an unsupported `schemaVersion` throws (mirror plan-events.test.ts:88-175).

**Proposed `PlanSuperseded` payload** (carries holistic scope state per D-21-1; ASSUMED — confirm field names in planning):
```typescript
// Mirror planAcceptedSchema (schemas.ts:230-239) + the holistic-scope requirement.
export const planSupersededSchema = eventSchema("PlanSuperseded", z.object({
  epochId: id,
  scopeHash: id,
  priorPlanId: id,            // the plan being superseded
  trailerId: id,              // same optimizer-${trailerId} stream as PlanAccepted
  supersededPackageIds: z.array(id),  // OR an explicit scope so the reducer wipes stale staged
  reason: z.string().min(1),  // audit trail: "freight unstaged because plan X superseded"
  occurredAt,
}));
```

### Pattern 5: Postgres table + idempotent migration (`optimizer_idempotency`)
**What:** A durable epoch-claim table replacing the in-memory `LruMap`.
**Migration mechanism (verified):** there is **no migration runner** — `migrate()` (`event-store/src/migrate.ts`) applies the WHOLE `SCHEMA_SQL` string via `sql.raw(SCHEMA_SQL).execute(db)`, and every statement is `CREATE TABLE IF NOT EXISTS` (idempotent, safe on every boot). The canonical DDL lives in `schema.sql`; a byte-identical embedded string lives in `schema.ts` (a unit test enforces they match — see `schema.ts:9-10`). **Add the new table to BOTH files.** Tests get Postgres via `pg-fixture.ts` (Testcontainers `postgres:17`, or `MM_PG_URL`/`DATABASE_URL` override), which calls `migrate()` at setup (`pg-fixture.ts:48, 83`).
```sql
-- Source pattern: packages/event-store/src/schema.sql (projection_checkpoints, :37-40)
-- Google-consult durable-idempotency hardening (item 4):
CREATE TABLE IF NOT EXISTS optimizer_idempotency (
  horizon_start  BIGINT  NOT NULL,
  horizon_end    BIGINT  NOT NULL,
  scope_hash     TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'PROCESSING',  -- PROCESSING | COMPLETED | FAILED
  plan_id        TEXT,
  claimed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ,
  CONSTRAINT uq_optimizer_idempotency UNIQUE (horizon_start, horizon_end, scope_hash)
);
```
Claim an epoch atomically (Kysely):
```typescript
// INSERT ... ON CONFLICT DO NOTHING RETURNING — RETURNING-empty ⇒ another worker already claimed it.
const claimed = await db.insertInto("optimizer_idempotency")
  .values({ horizon_start, horizon_end, scope_hash, status: "PROCESSING" })
  .onConflict((oc) => oc.columns(["horizon_start", "horizon_end", "scope_hash"]).doNothing())
  .returningAll().executeTakeFirst();
if (claimed === undefined) return /* already processed — skip append (idempotent) */;
// ... appendPlan ... then UPDATE status='COMPLETED', completed_at=now()
```

### Pattern 6: VIZ-12 `direction` derivation
**What:** Add `direction: 'outbound' | 'consolidation'` to `TrailerKeyframe`; derive from the leg's `from_hub_id`.
**Where:** `buildTrailerKeyframes` already resolves `routeId = legRouteId(from_hub_id, to_hub_id)` (snapshots.ts:303-307, 488). `InflightLeg` carries `from_hub_id`/`to_hub_id` (snapshots.ts:276-279). `center = hubs[0]` (Memphis; engine.ts:625, exported as `MEMPHIS` from `network/hubs.js`). So `direction = from_hub_id === MEMPHIS.hubId ? 'outbound' : 'consolidation'`. Add the field to `TrailerKeyframe` (envelope.ts:47-59) as **optional + additive** (back-compat with older clients, like `TrailerStop`/driver buckets), and add it to `trailerChanged` (envelope.ts:274) so a direction change re-emits.

### Anti-Patterns to Avoid
- **Pushing supersession logic into the reducer (REJECTED by D-21-1).** The reducer must be a dumb pure delete-then-apply driven by the explicit `PlanSuperseded` event — never an epoch/scope comparison inside the projector.
- **`SELECT *` / physical-order reads feeding `scopeHash`.** twin-snapshot.ts:418-419 currently uses `selectAll().execute()` with NO `ORDER BY` — add explicit `ORDER BY` over a stable key (e.g. `hub_id`, `trailer_id`) so the canonicalized hash is stable when both directions populate inventory. (`scopeHash` itself recursively sorts object KEYS via `canonicalize`, but array ORDER from the SQL read is preserved — so the read order matters.)
- **Adding a closure to the EventQueue.** New event sources MUST add a `SimTask` DATA variant (continuation.ts:24-25), never a closure — or the run is not resumable.
- **A new RNG substream "just in case."** Confirmed unnecessary (see RNG Decision). A spurious substream would force a new salt + continuation field + salt-collision-test update and risk perturbing draw order.
- **Touching `pendingBySpoke` ordering.** Re-sorting the existing distribution manifest would shift every golden. Apply the deterministic sort key to `pendingAtSpoke` ONLY.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Atomic multi-event append (PlanGenerated + PlanAccepted + PlanSuperseded in one tx) | A bespoke transaction | `appendWithRetry(db, stream, () => events, occurredAt)` (rolling-service.ts:191) | Already handles optimistic-concurrency `ConcurrencyError` retry + per-stream versioning. |
| Ephemeral Postgres for the idempotency + supersession integration tests | A mock DB | `startPgFixture()` (event-store/test/pg-fixture.ts) | Testcontainers `postgres:17` (or shared-server) with `migrate()` applied; the established int-test path. |
| Schema migration | A migration framework | Append `CREATE TABLE IF NOT EXISTS` to `schema.sql` + `schema.ts`; `migrate()` applies it | The repo's whole-schema idempotent apply (migrate.ts) — no Flyway/Knex. |
| Exhaustiveness enforcement when adding `PlanSuperseded` | Manual audit of every switch | `assertNever`/`assertNeverEvent` + `contract.assert.ts` | The build fails until all 11 reducers + the contract handle the new member. |
| Canonical idempotency hash | A new hash | `scopeHash(scope, twinSnapshot)` (freeze-idempotency.ts:44) | Recursive key-sort + sha256 already in place; only the SQL read ORDER needs fixing. |
| Continuation serialization of `pendingAtSpoke` | A custom serializer | The `SerializedWorldState` tuple-array pattern (continuation.ts:80-99) | JSON-round-trippable, deterministic field order already proven by the equivalence test. |

**Key insight:** Phase 21 introduces essentially no new *mechanisms* — it composes proven ones. The risk is entirely in determinism discipline and the two net-new artifacts (`PlanSuperseded`, `optimizer_idempotency`), both of which have direct templates.

## Runtime State Inventory

> Phase 21 is additive (a new opt-in flag + a new event + a new table); it is NOT a rename/refactor. This inventory is included because the new `optimizer_idempotency` table and the `PlanSuperseded` event change durable state semantics.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Event log (`events` table) gains a new `PlanSuperseded` event_type; `hub_inventory.staged` JSONB semantics change (now also cleared by supersession). | Code edit only. Goldens replay from `global_seq=0`, so no data migration; the new event simply never appears in flags-off goldens. |
| Live service config | None — single-process demo; no externally-configured services. | None — verified: no n8n/Datadog/cron in repo. |
| OS-registered state | None — no Task Scheduler / launchd / pm2 process names embed phase strings. | None — verified by repo scan. |
| Secrets/env vars | `MM_PG_URL` / `DATABASE_URL` already drive the PG fixture; no new secret. The new table is created by the same `migrate()`. | None. |
| Build artifacts | `schema.ts` embeds a byte-identical copy of `schema.sql` (enforced by a unit test). Adding the table to one file without the other fails that test. | Update BOTH `schema.sql` and `schema.ts` in the same task. |

**Nothing found** in Live service config / OS-registered state / new secrets — verified by grep across the repo (no `optimizer_idempotency`, `PlanSuperseded`, `is_active` exist yet; no external service config files present).

## Common Pitfalls

### Pitfall 1: A spurious RNG draw or substream silently shifts every golden
**What goes wrong:** Any new `rng`/`inductionRng`/etc. draw on the consolidation path — even a `pick` for "which spoke consolidates" — reorders the seeded sequence and breaks `3920accc…`.
**Why it happens:** All substreams advance lazily; an extra draw cascades through all downstream timing.
**How to avoid:** Consolidation reuses EXISTING freight (induction-origin or center-distribution packages already drawn) and deterministic selection (sort by `trailerId`/`freightId`, modular-arithmetic cadence — exactly like `sortWave`'s "pure modular arithmetic, no RNG salt", engine.ts:980). **No new RNG.** If the planner finds a place that *seems* to need randomness, that is a design smell — make it deterministic instead.
**Warning signs:** `consolidationEnabled:false` golden hash differs from `3920accc…`; the salt-collision test would need a new salt (it should NOT).

### Pitfall 2: `pendingAtSpoke` not captured ⇒ chunked run diverges
**What goes wrong:** A continuation captured mid-consolidation (a manifest partially built, a pending `arriveConsolidationAtCenter` task in flight) resumes with an empty manifest ⇒ chunked ≠ all-at-once.
**Why it happens:** `captureContinuation` (engine.ts:1722) serializes only what's listed; an un-listed Map is silently lost.
**How to avoid:** Add `pendingAtSpoke` to `SerializedWorldState` (continuation.ts:80) AND to the `world` object in `captureContinuation` (engine.ts:1724) AND restore it on resume (engine.ts:967-970 pattern). Add a `consolidationEnabled:true` case to `continuation-equivalence.unit.test.ts` (the FEATURE_CASES array, :115) at chunk-1 AND chunk-7 so a boundary lands mid-consolidation.
**Warning signs:** The new continuation-equivalence case fails at chunk-1 (boundary every tick) but passes at chunk-500.

### Pitfall 3: Double-drain / two trailers take the same packages
**What goes wrong:** Two consolidation trailers at one spoke in the same tick both read `pendingAtSpoke[spoke]` before either removes ⇒ ghost-duplicate manifests.
**Why it happens:** Non-atomic peek-then-pop, or iterating trailers in Map/Set order.
**How to avoid:** `splice(0, length)` is atomic (one statement removes-and-returns) — already the `pendingBySpoke` pattern (engine.ts:1284). Process idle trailers in stable `trailerId` order. One trailer empties the manifest; the next sees `[]` (a valid empty return).
**Warning signs:** A package id appears in two `TrailerDeparted.packageIds` within one run; `hub_inventory` count goes negative-ish (a package "left" twice).

### Pitfall 4: Stale `staged` double-counts consolidation freight at the center
**What goes wrong:** An old plan staged package P at the center; a new plan re-routes P; both the stale `staged` entry and the fresh `inbound` arrival count P ⇒ optimizer sees double demand.
**Why it happens:** No supersession today — `PlanAccepted` is a no-op in `hubInventoryReducer` (hub-inventory.ts:212), and `staged` is populated by `PackageScanned scanType="unload"` (hub-inventory.ts:144), NOT by `PlanAccepted`. **IMPORTANT DESIGN NOTE:** the current `staged` semantics ("unloaded into the yard") differ from the CONTEXT's framing ("optimizer-plan-staged"). The planner must reconcile this: either (a) `PlanAccepted` begins staging packages and `PlanSuperseded` un-stages them (a behavior change to `staged`), or (b) supersession targets a *separate* plan-staging concept. Recommend (a) with the dumb delete-then-apply reducer per D-21-1, but FLAG it as a design decision because today nothing stages on `PlanAccepted`.
**How to avoid:** Emit `PlanSuperseded` in the SAME `appendPlan` batch (rolling-service.ts:179-192); reducer wipes `staged` for the superseded scope (carry holistic scope OR `state.epoch < event.epoch`).
**Warning signs:** Center `hub_inventory.staged + inbound` counts exceed the number of packages physically present.

### Pitfall 5: Twin-snapshot SELECT order makes `scopeHash` non-deterministic across directions
**What goes wrong:** With both directions populating `hub_inventory`, the unordered `selectAll()` (twin-snapshot.ts:418-419) can return rows in a different physical order across runs/restarts ⇒ `scopeHash` differs ⇒ a "frozen" epoch re-fires or an idempotent epoch re-appends.
**Why it happens:** Postgres makes no order guarantee without `ORDER BY`.
**How to avoid:** Add `.orderBy("hub_id")` / `.orderBy("trailer_id")` to the twin reads. (`scopeHash`'s `canonicalize` sorts object KEYS but preserves array ORDER, so the *read* order is load-bearing.)
**Warning signs:** Restart-then-resume produces a different `scopeHash` for the same logical epoch; the new persistent-idempotency int test is flaky.

### Pitfall 6: Detection cost scales with total-ever packages (pre-existing debt, worsened here)
**What goes wrong:** `runDetection` reads `trailer_state` + `zone_estimate` with no active filter (detector.ts:174, 186, 205); under continuous + bidirectional freight, cost grows with all packages ever.
**How to avoid:** Scope `makeProjectionReads` queries to active packages (FLOW-04). Note there is **no `is_active` column today** — the planner must add one (e.g. to `package_location` or `zone_estimate`) or filter via a "package not yet arrived at final dest" predicate. Benchmark at a bounded state size (a Vitest perf assertion at ~1–5k packages, NOT 10k+, per GATE-HYGIENE).
**Warning signs:** The bounded benchmark shows superlinear detection time.

## Code Examples

### Adding the `consolidationEnabled:false ⇒ byte-identical` determinism test (mirror over-carry)
```typescript
// Source pattern: packages/simulation/test/over-carry.unit.test.ts:57-84 and
//                 packages/simulation/test/induction-determinism.unit.test.ts:41-45
const CENTER = MEMPHIS.hubId;  // hubs[0]

it("consolidationEnabled ABSENT ⇒ ZERO consolidation departures (DET-01)", () => {
  const s = simulate({ seed: 1234, durationTicks: 6000 });
  const spokeOrigin = s.filter(e => e.event.type === "TrailerDeparted"
    && (e.event as TrailerDeparted).payload.fromHubId !== CENTER);
  expect(spokeOrigin).toHaveLength(0);   // no spoke-origin legs when off (over-carry also off)
});

it("consolidationEnabled:false ⇒ byte-identical to absent (DET-01)", () => {
  const a = simulate({ seed: 1234, durationTicks: 6000 });
  const b = simulate({ seed: 1234, durationTicks: 6000, consolidationEnabled: false });
  expect(JSON.stringify(b)).toBe(JSON.stringify(a));
});

it("the seed-42 10k golden is byte-identical with consolidationEnabled:false", () => {
  const hash = createHash("sha256")
    .update(JSON.stringify(simulate({ seed: 42, durationTicks: 10000, consolidationEnabled: false })))
    .digest("hex");
  expect(hash).toBe("3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861");
});
```

### Extending the continuation-equivalence test (the make-or-break gate)
```typescript
// Source: packages/simulation/test/continuation-equivalence.unit.test.ts:115-156 (FEATURE_CASES)
// Add a consolidation case to FEATURE_CASES; it runs at chunk-1 (every tick) + chunk-7.
{
  name: "consolidation",
  opts: { timing: SHORT_TIMING, consolidationEnabled: true /* + inductionEnabled:true to source freight */ },
},
// Bound: seed 1234, horizon 800 (the existing bound) — keeps the full gate ~15min (GATE-HYGIENE).
```

### `PlanSuperseded` round-trip + strict-reject (mirror plan-events.test.ts)
```typescript
// Source pattern: packages/domain/src/events/plan-events.test.ts:88-175
const planSuperseded: PlanSuperseded = {
  type: "PlanSuperseded", schemaVersion: 1,
  payload: { epochId: "epoch-8", scopeHash: "sha256:abc", priorPlanId: "plan-42",
             trailerId: "T1", supersededPackageIds: ["P00001"], reason: "superseded by plan-43",
             occurredAt: "2026-06-24T12:00:02.000Z" },
};
it("round-trips a well-formed PlanSuperseded", () => {
  expect(validateEvent(planSuperseded)).toEqual(planSuperseded);
});
it("rejects an extra field (.strict payload)", () => {
  expect(() => validateEvent({ ...planSuperseded,
    payload: { ...planSuperseded.payload, extra: 1 } })).toThrow(ValidationError);
});
```

## State of the Art

| Old Approach (today) | Current Approach (Phase 21) | When Changed | Impact |
|----------------------|------------------------------|--------------|--------|
| Trailers return empty (only over-carry puts 1 pkg on a return leg) | `pendingAtSpoke` consolidation manifests carry real freight spoke→center | Phase 21 | Genuine bidirectional flow; the center becomes a true cross-dock. |
| In-memory `LruMap` idempotency (cap 500), lost on restart (v1.0 debt) | Durable `optimizer_idempotency` Postgres table with `status` for crash recovery | Phase 21 | Idempotency survives restarts under continuous operation (closes v1.0 debt). |
| No supersession — stale `staged`/plan entries linger | Explicit `PlanSuperseded` event, atomic with `PlanAccepted`, dumb delete-then-apply reducer | Phase 21 (D-21-1) | No double-counting; auditable; replay-from-zero clean. |
| `runDetection` scans all packages ever | `is_active`-scoped reads (bounded benchmark) | Phase 21 | Detection cost stops scaling with total-ever (worsened by continuous induction). |

**Deprecated/outdated:** none — this is purely additive; no existing API is removed.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `PlanSuperseded` payload fields (`priorPlanId`, `supersededPackageIds`, `reason`) | Pattern 4 | Field names are a design choice; D-21-1 mandates "holistic scope state" but not the exact schema. Low risk — confirm in planning; the ceremony is what matters. |
| A2 | `staged` should be (re)defined so `PlanAccepted` stages and `PlanSuperseded` un-stages it | Pitfall 4 | MEDIUM — today `staged` = unload scans, NOT plan-staged. If the planner instead introduces a separate plan-staging projection, the reducer wiring differs. The supersession MECHANISM (explicit event + delete-then-apply) is locked; the TARGET projection needs a design decision. |
| A3 | `is_active` does not exist and must be added (column or predicate) for FLOW-04 detection scoping | Pitfall 6 | LOW — verified zero matches today; the planner chooses where the active flag lives. |
| A4 | Consolidation reuses existing freight ⇒ no new RNG (CONTEXT-locked, re-verified) | RNG Decision | LOW — locked by CONTEXT; this research confirms no induction/center freight needs a new draw. If discretionary "which spoke consolidates" is made random rather than deterministic, A4 breaks — keep it deterministic. |
| A5 | `optimizer_idempotency` key is `(horizon_start, horizon_end, scope_hash)` | Pattern 5 | LOW — directly from Google-consult item 4; epoch identity in code is `${epochId}:${scopeHash}` (rolling-service.ts:142), where `epochId` derives from `simMs` — confirm the horizon columns map to the epoch horizon, not `epochId`, in planning. |

## Open Questions

1. **Does `PlanAccepted` begin staging freight in `hub_inventory.staged`, or does supersession target a new plan-staging projection?**
   - What we know: today `staged` = `PackageScanned scanType="unload"` (hub-inventory.ts:144); `PlanAccepted` is a no-op there (hub-inventory.ts:212). The CONTEXT frames `staged` as "optimizer-plan-staged."
   - What's unclear: whether Phase 21 repurposes `staged` (a behavior change) or adds a new projection.
   - Recommendation: repurpose `staged` per D-21-1 (dumb delete-then-apply), but make this an explicit planning decision and add a regression test that the unload-scan staging path still works for non-plan freight. **This is the single most important design decision for FLOW-04.**

2. **`epochId` (from `simMs`) vs the idempotency table's horizon columns.**
   - What we know: the memo key is `${epochId}:${scopeHash}` (rolling-service.ts:142); the consult specifies `UNIQUE(horizon_start, horizon_end, scope_hash)`.
   - What's unclear: whether `horizon_start/end` come from `epoch.nowMin`/`+DEFAULT_HORIZON_MIN` (scope.ts:125-126) or from `epochId`.
   - Recommendation: key on the scope horizon (`scope.horizonStartMin`/`horizonEndMin`) + `scope_hash` so a restart at the same sim-time re-claims the same row; confirm in planning.

3. **Empty-return threshold (Google-consult item 2).**
   - What we know: empty `pendingAtSpoke` is VALID (locked), but the consult warns against *silently* emitting empty returns.
   - What's unclear: the deterministic threshold (downstream-demand horizon vs trailer-starvation guard).
   - Recommendation: simplest deterministic rule — a consolidation departure fires on the same trailer re-dispatch cadence the demo already uses; an empty manifest just departs empty (no special threshold) UNLESS the planner wants the richer guard. Keep it deterministic either way.

## RNG Decision (explicit, per the objective)

**No new RNG substream is required.** Verified:
- The six+1 existing salts are `RFID_RNG_SALT`, `OVER_CARRY_RNG_SALT`, `TIMING_RNG_SALT`, `HOS_RNG_SALT`, `FUEL_RNG_SALT`, `base rng`, and `INDUCTION_RNG_SALT` (engine.ts:85-116). The salt-collision/pairwise-distinct test lives in `packages/simulation/test/fuel-determinism.unit.test.ts:41-74` (NOT in `rng-state` — it asserts the 7-salt set has no duplicates).
- Consolidation freight is EXISTING freight (induction-origin packages from `inductionRng`, already drawn at induction time, or center-distribution packages from `base rng`). Re-staging/routing them is pure deterministic bookkeeping.
- Discretionary choices (which spoke consolidates, cadence, freight selection) MUST be deterministic — modular arithmetic on the tick (the `sortWave` precedent, engine.ts:980, draws NO RNG) and stable `trailerId`/`freightId` sorting.
- **Therefore:** do NOT add a salt; do NOT add a `consolidation` field to `SerializedRngStates` (continuation.ts:102-112); do NOT touch the salt-collision test. If, during planning, any consolidation step is made random, the rule is: add a new pairwise-distinct salt, construct the substream ONLY when `consolidationOn`, capture its state in `SimContinuation.rng` (mirror `induction: inductionRng?.getState()`, engine.ts:1756), and extend the salt-collision test — exactly the Phase-20 induction pattern. **Strongly prefer deterministic over a new substream.**

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All | ✓ | v23.11.0 (engines `>=22`) | — |
| pnpm + Turborepo | Build/gate | ✓ | (workspace) | — |
| Docker / OrbStack | Postgres int tests (Testcontainers) | ✓ (assumed — existing int tests pass) | `postgres:17` image | `MM_PG_URL` / `DATABASE_URL` env to a running PG (pg-fixture.ts:36-76) |
| PostgreSQL 17 | event-store + projections + new idempotency table | ✓ via Testcontainers or env | 16/17 | shared-server `MM_PG_URL` |
| npm registry (version verify) | Research | ✓ | — | — |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** Postgres for tests has three paths (`MM_PG_URL` shared server → `DATABASE_URL` direct → Testcontainers `postgres:17`), all wired in `pg-fixture.ts`.

## Validation Architecture

> `workflow.nyquist_validation` is enabled (config.json) — section included.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.x (projects: `unit`, `integration`, `ui`, `browser`) |
| Config file | root `vitest` projects; `vitest.coverage.config.ts` aliases `@mm/*`→src |
| Quick run command | `vitest run --project unit` (or `pnpm test`, which builds first) |
| Full suite command | `pnpm test:all` (`turbo run build && vitest run --no-file-parallelism --project unit --project integration --project ui`) |
| Full gate | `pnpm build && pnpm typecheck && pnpm lint && pnpm test:all` (typecheck = `tsc -p tsconfig.eslint.json --noEmit` — separate gate that catches test-file TS errors build/lint/vitest miss) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FLOW-01 | spoke-origin `TrailerDeparted` (from≠center) carries real freight from `pendingAtSpoke` | unit | `vitest run packages/simulation/test/consolidation-determinism.unit.test.ts` | ❌ Wave 0 (mirror over-carry.unit.test.ts) |
| FLOW-02 | center arrival unloads + re-stages into `pendingBySpoke[destSpoke]` (cross-dock) | unit | same file — assert a re-staged package later departs center→destSpoke | ❌ Wave 0 |
| FLOW-03 | `consolidationEnabled:false` byte-identical to absent; seed-42 10k = `3920accc…`; empty return valid | unit | `vitest run packages/simulation/test/determinism.unit.test.ts` (extend) + consolidation file | ⚠️ EXTEND determinism.unit.test.ts |
| FLOW-03 | chunked == all-at-once with `consolidationEnabled:true` (continuation captured) | unit | `vitest run packages/simulation/test/continuation-equivalence.unit.test.ts` | ⚠️ EXTEND (add FEATURE_CASES entry) |
| FLOW-04 | `PlanSuperseded` round-trips + `.strict` rejects extras + exhaustive in all 11 reducers | unit | `vitest run packages/domain` + `vitest run packages/projections` | ❌ Wave 0 (mirror plan-events.test.ts + reducer tests) |
| FLOW-04 | durable idempotency: same `(horizon, scopeHash)` claimed once across a simulated restart; `scopeHash` stable with ORDER BY | integration | `vitest run --project integration packages/api/.../rolling-service*.int.test.ts` | ❌ Wave 0 (uses pg-fixture; BOUNDED — one epoch, one restart) |
| FLOW-04 | supersession clears stale `staged` (delete-then-apply); no double-count | unit/int | hub-inventory reducer test + a bounded projection int test | ❌ Wave 0 |
| FLOW-04 | detection bounded — `is_active` scoping benchmark at ~1–5k packages | unit (perf) | `vitest run packages/projections/.../detector-bound*.test.ts` | ❌ Wave 0 (BOUNDED, not 10k) |
| VIZ-12 | `TrailerKeyframe.direction` set; consolidation legs ⇒ `'consolidation'`; diff re-emits on change | unit | `vitest run packages/api/src/ws/envelope.test.ts` + `snapshots.test.ts` (extend) | ⚠️ EXTEND |
| VIZ-12 | map renders distinct style per direction | ui/browser | `vitest run --project ui packages/web/.../layers*.test.ts` | ❌ Wave 0 (mirror inductionLayer.test.ts) |
| FLOW-05 (P2) | hub inbound/outbound balance in read API + panel | int + ui | `vitest run packages/api/src/routes/hub-detail.test.ts` (extend) + web panel test | ⚠️ EXTEND |

### Sampling Rate (Nyquist)
- **Per task commit:** `vitest run --project unit` for the touched package (the observable signal for each engine/domain/reducer change is a deterministic event-stream/hash assertion — sampled every commit).
- **Per wave merge:** `pnpm test:all` (unit + integration + ui) — the integration lane exercises the Postgres idempotency + supersession projection paths.
- **Phase gate:** full gate (`build + typecheck + lint + test:all`) green, INCLUDING the seed-42 10k golden (`3920accc…`) and the new `consolidationEnabled:true` continuation-equivalence case, before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `packages/simulation/test/consolidation-determinism.unit.test.ts` — covers FLOW-01/02/03 (mirror `over-carry.unit.test.ts`); BOUNDED (seed 1234 @ ≤6000, the existing determinism horizon).
- [ ] EXTEND `packages/simulation/test/continuation-equivalence.unit.test.ts` — add a `consolidation` FEATURE_CASE at chunk-1 + chunk-7, seed 1234 @ 800 (existing bound).
- [ ] EXTEND `packages/simulation/test/determinism.unit.test.ts` — add a `consolidationEnabled:false` byte-identical assertion to the DET-01 gate.
- [ ] `packages/domain/src/events/plan-superseded.test.ts` (or extend `plan-events.test.ts`) — round-trip + strict-reject + union-membership for `PlanSuperseded`.
- [ ] Reducer tests: hub-inventory `PlanSuperseded` delete-then-apply; the other 10 reducers' no-op branch (the existing exhaustiveness pattern makes the build the primary witness).
- [ ] `packages/api/.../rolling-service` integration test — durable idempotency claim across a restart; uses `startPgFixture()`; BOUNDED to one epoch + one simulated restart.
- [ ] Detection-bound perf test at ~1–5k packages (NOT 10k — GATE-HYGIENE).
- [ ] EXTEND `packages/api/src/ws/envelope.test.ts` / `snapshots.test.ts` for `direction`.
- [ ] Web: VIZ-12 layer style test (mirror `packages/web/src/map/inductionLayer.test.ts`).

## Project Constraints (from CLAUDE.md)

- **TypeScript strict, no `any`** (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`). New code must type cleanly under `pnpm typecheck`.
- **TDD required** — Wave 0 RED stubs before implementation (the established v2.0 cadence: ROADMAP 19-01/20-01 are "Wave 0 RED test stubs").
- **Event sourcing patterns** — closed `DomainEvent` union + Zod `.strict()` + `assertNever`-exhaustive reducers; events keyed off `occurredAt` (virtual clock), never wall-clock.
- **Kysely/pg only** (no Prisma); raw SQL for the event store and the new idempotency table.
- **Custom optimizer** (no `node_or_tools`/`min-cost-flow`); the rolling shell is the only side-effecting writer.
- **No new runtime dependencies** (milestone verdict + CLAUDE.md "What NOT to Use"). Phase 21 adds zero.
- **Gate:** `pnpm build` (turbo, not `-r`) + `pnpm typecheck` + `pnpm lint` + `pnpm test:all`. Include `typecheck` explicitly (catches test-file TS errors the others miss).
- **GSD workflow** — all edits go through a GSD command (this is a planned phase ⇒ `/gsd-execute-phase`).

## Sources

### Primary (HIGH confidence — codebase reads, this session)
- `packages/simulation/src/engine.ts` — `SimulateOptions` (147-282), salts (85-116), substream construction (492-567), `pendingBySpoke` (966-972), departure drain (1283-1284), induction handler (1049-1110), over-carry return leg (1503-1547), `arriveOverCarriedAtCenter` (1581-1613), `dispatch` switch (1635-1666), seed schedule (1669-1692), drain loop (1701-1714), `captureContinuation` (1722-1763), `center=hubs[0]`/`spokes` (625-626).
- `packages/simulation/src/continuation.ts` — `SimTask` union (27-55), `SerializedWorldState` (80-99), `SerializedRngStates` (102-112), `SimContinuation` (118-144).
- `packages/simulation/test/determinism.unit.test.ts` — golden seed-1234@6000 (20), seed-42@10000 `3920accc…` (125-126), same-tick tie-break (161-184), DET-01 flags-off gate (194-208).
- `packages/simulation/test/continuation-equivalence.unit.test.ts` — `chunkedStream` (47-64), FEATURE_CASES incl. all-on/induction (115-156).
- `packages/simulation/test/induction-determinism.unit.test.ts` — off⇒zero / off⇒byte-identical pattern (35-100).
- `packages/simulation/test/over-carry.unit.test.ts` — spoke-origin departure assertions (57-90).
- `packages/simulation/test/fuel-determinism.unit.test.ts` — the salt-collision/pairwise-distinct test (41-74).
- `packages/domain/src/events/{domain-event.ts,schemas.ts,contract.assert.ts,index.ts}` + `events/index.ts`, `events/plan-events.test.ts`, `ingestion/validate.ts` — the closed-union ceremony.
- `packages/projections/src/reducers/hub-inventory.ts` (full) + `reducer.ts` + 10 other reducers (all switch `event.type` + `assertNeverEvent`, all no-op `PlanAccepted` today).
- `packages/optimizer/src/rolling/{scope.ts,freeze-idempotency.ts}` — `hubsOf`/`trailersOf` direction-agnostic, `scopeHash` canonicalize, `isFrozen`.
- `packages/api/src/optimizer/{rolling-service.ts,lru-map.ts,twin-snapshot.ts}` — memo `LruMap` (94), `appendPlan` atomic append (179-192), twin SELECTs without ORDER BY (418-419).
- `packages/api/src/ws/{envelope.ts,snapshots.ts}` — `TrailerKeyframe` (47-59), `trailerChanged` (274), `buildTrailerKeyframes`/`legRouteId` (296-352), `InflightLeg` (276-279).
- `packages/event-store/src/{schema.sql,migrate.ts}` + `test/pg-fixture.ts`; `packages/projections/src/{schema.sql,detector.ts}`.
- `package.json` scripts (gate); `.planning/config.json` (nyquist_validation on, no project skills).

### Secondary (MEDIUM confidence)
- `npm view` (2026-06-24) — version confirmations: fastify 5.8.5, kysely 0.29.2, pg 8.22.0, vitest 4.1.9, zod 4.4.3, @testcontainers/postgresql 12.0.3, typescript 6.0.3 (registry latest; project pins 5.9).
- `.planning/research/SUMMARY.md`, `21-CONTEXT.md`, `REQUIREMENTS.md`, `ROADMAP.md` — milestone framing, D-21-1, Google-consult gates.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — brownfield; versions verified against the registry; zero new deps.
- Architecture / integration points: HIGH — every file path, line anchor, and signature read this session; the over-carry return leg + induction ceremony are exact, tested precedents.
- Pitfalls: HIGH — each traces to a specific source line; the one design ambiguity (`staged` semantics, Pitfall 4 / Open Q1) is flagged explicitly, not hidden.
- The two net-new artifacts (`PlanSuperseded`, `optimizer_idempotency`): MEDIUM on exact schema/columns (A1, A5), HIGH on the mechanism/ceremony.

**Research date:** 2026-06-24
**Valid until:** 2026-07-24 (stable brownfield; ~7 days if the engine/optimizer is refactored — re-verify line anchors, which drift).
