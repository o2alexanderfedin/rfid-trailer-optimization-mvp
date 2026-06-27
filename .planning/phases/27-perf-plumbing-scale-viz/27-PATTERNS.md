# Phase 27: Perf + Plumbing + Scale Viz - Pattern Map

**Mapped:** 2026-06-26
**Files analyzed:** 24 (new + modified across PERF-02/03, VIZ-15/16/17, P27-A/B)
**Analogs found:** 24 / 24 (every file has a precise in-repo analog — CONTEXT pre-named most; this doc pulls the concrete excerpts)

> All paths absolute under `/Volumes/Unitek-B/Projects/jobs/intelliswift`.
> CONTEXT.md already named the analogs by `file:line`. This map extracts the **load-bearing code excerpts** so each executor can replicate the shape exactly — copy these, do not re-derive.

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| **PERF-02** | | | | |
| `packages/projections/src/reducers/induction-deadline.ts` (new) | reducer (projection) | event-driven (LWW) | `reducers/trailer-fuel.ts` | role-match (trailer-fuel is the carried reducer to reuse) |
| `packages/projections/src/runner/inline.ts` (modify: 2 appliers + 2 APPLIERS entries) | runner/applier | event-driven CRUD | `applyDriverStatus` (`inline.ts:282`), `applyPackageLocation` (`inline.ts:145`) | exact |
| `packages/projections/src/schema.ts` (modify: 2 tables, registry, DDL) | config/schema | — | `driver_status` table + `OPERATIONAL_PROJECTIONS` registry | exact |
| `packages/projections/src/runner/rebuild.ts` (modify: TRUNCATE + serializeTwin) | runner | batch | `rebuild.ts:50` TRUNCATE list + `serializeTwin` | exact |
| `packages/api/src/optimizer/twin-snapshot.ts` (modify: 2 scans → bounded reads) | service (read) | request-response | `readOperationalTwin` bounded `selectFrom` (`inline.ts:933`) | exact |
| `packages/projections/test/induction-deadline.unit.test.ts` (new) | test | — | `test/hub-inventory-cost.unit.test.ts` (rebuild-equivalence + counting fake) | exact |
| `packages/api/test/projections-golden-replay.int.test.ts` (modify: add tables) | test | — | itself (extend serialize surface) | exact |
| **PERF-03** | | | | |
| `pnpm-workspace.yaml` / vendor build wiring | config | — | (greenfield; vendor `package.json` `prepare`) | n/a |
| `packages/api/src/optimizer/worker-client.ts` (modify: bound pending Map) | utility (transport) | request-response | `vendor/async-queue` `AsyncQueue<T>` | role-match |
| `packages/event-store/src/store.ts` (modify: batch INSERT loop) | service (persistence) | batch write | `appendToStream` insert loop (`store.ts:111`) | exact (self) |
| `packages/api/src/ws/snapshots.ts` (modify: per-client queue) | service (transport) | streaming/pub-sub | `sendRawIfOpen` / drop-gate (`snapshots.ts:691,718,905`) | exact (self) |
| `eslint.config.ts` (modify: widen DET-03 ban) | config | — | DET-03 block `eslint.config.ts:103-225` | exact |
| `packages/api/test/async-queue-order.*.test.ts` (new) | test | — | (greenfield; FIFO assertion) | n/a |
| **VIZ-15/16** | | | | |
| `packages/web/src/map/layers.ts` (modify: Cluster + VectorImageLayer + suggestion layer) | provider (map) | streaming | `createHubLayer`/`createInductionLayer`/`flashInduction` | exact |
| `packages/web/src/map/coloring.ts` (modify: tier-branched style fns) | utility (style) | transform | `hubStyle`/`routeStyle` cached cache (`coloring.ts:119,205`) | exact |
| `packages/api/src/ws/envelope.ts` (modify: HubState `kind`/`tier`, RouteState `isBackbone`, `TickPayload.suggestions`) | model (DTO) | streaming | `HubState`/`RouteState`/`InductionEvent`/`TickPayload` | exact |
| `packages/api/src/app.ts` (modify: HubDto `kind`/`tier`) | controller/DTO | request-response | `GET /hubs` map (`app.ts:26-34`) | exact |
| `packages/api/src/routes/queries.ts` (modify: RouteDto `isBackbone`) | controller/DTO | request-response | `RouteDto` (`queries.ts:64`) | exact |
| `packages/web/src/map/suggestionColoring.ts` (new) | utility (style) | transform | `map/inductionColoring.ts` (whole file) | exact |
| **VIZ-17** | | | | |
| `packages/web/src/panels/useSuggestions.ts` (new hook) | hook | event-driven | `useAlertFeed` (`AlertFeed.tsx:136`) | exact |
| `packages/web/src/panels/SuggestionFeed.tsx` (new component) | component | event-driven | `AlertFeed` component (`AlertFeed.tsx:172`) | exact |
| `packages/web/src/App.tsx` (modify: dispatch suggestions) | provider (wiring) | event-driven | `onAlertEnvelope` (`App.tsx:56`) | exact |
| `packages/web/src/panels/RightRail.tsx` (modify: add feed section) | component | — | Live Exceptions `<section>` (`RightRail.tsx:80-94`) | exact |
| **P27-A** | | | | |
| `packages/simulation/src/engine.ts` (modify: `optimizerRerouteFor` 3 pins) | service (engine core) | transform | `optimizerRerouteFor` (`engine.ts:2410-2531`) | exact (self) |
| `packages/simulation/src/coordinator/optimize.ts` (modify: real legs + read chosen hub) | service (adapter) | transform | `buildCenterTwinFromFold` + `epochResultToRerouteSuggestions` | exact (self) |
| `packages/simulation/test/coordinator-optimizer-determinism.unit.test.ts` (modify: flip equality→divergence + new golden) | test | — | itself (the documented-equality block) | exact (self) |
| **P27-B** | | | | |
| `packages/api/src/main.ts` (modify: continental demo fuel/HOS config) | config (demo runner) | — | `fuelConfig` literal (`main.ts:63-64`) + `DEFAULT_FUEL_CONFIG` (`fuel.ts:47`) | exact |

---

## Pattern Assignments

### AREA 1 — PERF-02 (incremental cursor-fold twin-snapshot, READ-SIDE, no golden)

#### `reducers/induction-deadline.ts` (new reducer) + the carried `trailer-fuel.ts`

**Analog (carry as-is, do NOT rewrite):** `packages/projections/src/reducers/trailer-fuel.ts` — the pure `trailerFuelReducer` already exists. PERF-02 *persists* it (it is currently only folded ephemerally inside `twin-snapshot.ts`). Its state already carries the internal `routes` + `inflight` indices (`trailer-fuel.ts:66-75`):

```typescript
export interface TrailerFuelState {
  readonly fuel: ReadonlyMap<string, TrailerFuel>;      // PERSIST this → trailer_fuel(trailer_id, miles_since_refuel)
  readonly routes: ReadonlyMap<string, readonly LonLat[]>;  // REUSE persisted geo_route (do NOT re-persist)
  readonly inflight: ReadonlyMap<string, string>;       // REUSE persisted geo_inflight_trip (do NOT re-persist)
  readonly size: number;
}
```

The reducer touches only the trailer keyed in the event payload — exactly the key-scoped property the applier needs. The four mutating cases are `RouteRegistered`/`TrailerDeparted`/`TrailerArrivedAtHub`/`TruckRefueled` (`trailer-fuel.ts:108-139`); everything else is a no-op via the closed switch + `assertNeverEvent`.

**New `induction-deadline.ts` reducer** — model it on the closed-switch shape of `trailer-fuel.ts`, but trivial LWW from `PackageInducted` (the source today is the throwaway scan `buildInductionDeadlines`, `twin-snapshot.ts:125-137`):

```typescript
// twin-snapshot.ts:129-135 — the LWW logic to lift into a pure reducer keyed by packageId:
for (const s of stored) {
  if (s.event.type !== "PackageInducted") continue;
  out.set(s.event.payload.packageId, isoToEpochMinutes(s.event.payload.slaDeadlineIso));
}
```

The reducer's empty-state + `withX` + `assertNeverEvent` closed switch must mirror `trailer-fuel.ts:77-172` so a new event type is a compile error.

#### `inline.ts` — two new key-scoped appliers + checkpoint wiring

**Analog:** `applyDriverStatus` (`inline.ts:282-346`) for the JSONB/multi-field upsert shape; `applyPackageLocation` (`inline.ts:145-191`) for the simplest single-key load-fold-persist-or-delete shape. **The exact applier skeleton to copy** (`applyPackageLocation`, `inline.ts:145-191`):

```typescript
async function applyPackageLocation(db: Kysely<ProjectionDb>, replay: ReplayEvent): Promise<void> {
  const id = affectedPackageLocationId(replay.event);
  if (id === null) return;                       // no-op event ⇒ no read, no write
  const rows = await db.selectFrom("package_location").selectAll()
    .where("package_id", "=", id).execute();     // load ONLY the affected key
  const state: PackageLocationState = new Map(rows.map((r) => [r.package_id, {/* row→state */}]));
  const next = packageLocationReducer(state, toOccurred(replay));   // SAME pure reducer
  const loc = next.get(id);
  if (loc === undefined) {                        // reducer removed it ⇒ delete delta
    await db.deleteFrom("package_location").where("package_id", "=", id).execute(); return;
  }
  await db.insertInto("package_location").values({/* state→row */})
    .onConflict((oc) => oc.column("package_id").doUpdateSet({/* updatable cols */})).execute();
}
```

**Checkpoint helpers** are shared & already typed at `OperationalProjectionName` — `readCheckpoint` (`inline.ts:85-95`), `advanceCheckpoint` (`inline.ts:98-110`), `toOccurred` (`inline.ts:112-114`). No new checkpoint code: the names just need to exist in `OPERATIONAL_PROJECTIONS` (below).

**For `trailer_fuel`'s applier:** the reducer reads `routes` + `inflight` from persisted tables — seed them exactly like `catchup.ts:loadGeoTrackState` (`runner/catchup.ts:177-194`) which already reads `geo_route` + `geo_inflight_trip` into the same Map shapes:

```typescript
const [routeRows, inflightRows] = await Promise.all([
  db.selectFrom("geo_route").selectAll().execute(),
  db.selectFrom("geo_inflight_trip").selectAll().execute(),
]);
const routes = new Map<string, readonly [number, number][]>();
for (const r of routeRows) routes.set(legKey(r.from_hub_id, r.to_hub_id), r.geometry);
// ...inflight seeded from geo_inflight_trip, keyed by trip_id
```
> NOTE: `catchup.ts` runs `geo-track` so those tables are already populated by an *existing* checkpoint. The `trailer_fuel` applier should READ them (precedent above) and persist only `(trailer_id, miles_since_refuel)`.

**APPLIERS registry entry** (`inline.ts:857-874`) — append two entries (order vs the others is immaterial for these disjoint reducers, same note as `exceptions`):

```typescript
const APPLIERS: ReadonlyArray<{ name: OperationalProjectionName; apply: Applier }> = [
  { name: "package-location", apply: applyPackageLocation },
  // ...existing 7...
  { name: "exceptions", apply: applyExceptions },
  // PERF-02 additions:
  { name: "trailer-fuel", apply: applyTrailerFuel },
  { name: "induction-deadline", apply: applyInductionDeadline },
];
```
The `applyInline` loop (`inline.ts:891-901`) picks them up automatically — no driver-side change. The driver's per-tick fold (`api/src/sim/driver.ts ~495/712/1049`) calls `applyInline`, so it folds the new projections with zero new fold loop (CONTEXT Area 1).

#### `schema.ts` — registry + tables + DTO types + DDL

**Registry** (`schema.ts:250-261`) — add both names to `OPERATIONAL_PROJECTIONS` (the const drives both the inline skip-gate and the rebuild reset):

```typescript
export const OPERATIONAL_PROJECTIONS = [
  "package-location", "trailer-state", "hub-inventory",
  "driver-status", "driver-assignment", "tag-registry",
  "zone-estimate", "exceptions",
  "trailer-fuel", "induction-deadline",     // PERF-02
] as const;
```

**`ProjectionDatabase` interface** (`schema.ts:228-242`) — add `trailer_fuel: TrailerFuelTable;` + `induction_deadline: InductionDeadlineTable;`, and add the two `Selectable<...>` row aliases beside `schema.ts:208-220`.

**DDL** — append to `PROJECTIONS_SCHEMA_SQL` (`schema.ts:274-471`); copy the smallest table form (`tag_registry`, `schema.ts:357-360`, a 2-col PK table) and keep idempotent `IF NOT EXISTS`:

```sql
-- PERF-02: a trailer's miles-since-last-refuel (the optimizer's fuel-aware odometer),
-- folded incrementally so twin-snapshot reads it bounded instead of re-scanning the log.
CREATE TABLE IF NOT EXISTS trailer_fuel (
  trailer_id        TEXT PRIMARY KEY,
  miles_since_refuel DOUBLE PRECISION NOT NULL DEFAULT 0
);

-- PERF-02: per-package SLA induction deadline (epoch-minutes), LWW from PackageInducted.
CREATE TABLE IF NOT EXISTS induction_deadline (
  package_id  TEXT PRIMARY KEY,
  deadline_min INTEGER NOT NULL
);
```
> A unit test keeps `PROJECTIONS_SCHEMA_SQL` byte-identical to `schema.sql` (`schema.ts:10` comment) — update BOTH files together.

#### `rebuild.ts` — TRUNCATE list + serialize surface

**TRUNCATE** (`rebuild.ts:50`) — add both tables to the single TRUNCATE statement:

```typescript
await sql`TRUNCATE TABLE package_location, trailer_state, hub_inventory, driver_status, driver_assignment, tag_registry, zone_estimate, exceptions, exception_kpi, trailer_fuel, induction_deadline`.execute(db);
```
The checkpoint-reset loop (`rebuild.ts:55-63`) iterates `OPERATIONAL_PROJECTIONS`, so adding the names there (above) auto-covers reset. **`serializeTwin`** (`rebuild.ts:79-145`) sorts each Map by its PK and emits fixed-key objects — add `trailerFuel` (sort by `trailerId`) and `inductionDeadline` (sort by `packageId`) blocks mirroring the `driverStatus` block (`rebuild.ts:111-126`), and extend the final `JSON.stringify({...})` object (`rebuild.ts:138-144`). `readOperationalTwin` (`inline.ts:933-959`) must also read the two new tables into the twin so they reach `serializeTwin`.

#### `twin-snapshot.ts` — switch the two scans to bounded reads

**Replace** `computeMilesSinceRefuel` (`twin-snapshot.ts:100-113`) and `buildInductionDeadlines` (`twin-snapshot.ts:125-137`) — both currently `readAll(es, 0n)` full-log folds — with bounded `db.selectFrom(...)` reads, mirroring the bounded read shape in `readOperationalTwin` (`inline.ts:937-944`):

```typescript
// NEW (read-side): replace the two readAll(0n) folds at twin-snapshot.ts:406-409
const [fuelRows, deadlineRows] = await Promise.all([
  db.selectFrom("trailer_fuel").selectAll().execute(),
  db.selectFrom("induction_deadline").selectAll().execute(),
]);
const milesSinceRefuelByTrailer = new Map(fuelRows.map((r) => [r.trailer_id, r.miles_since_refuel]));
const inductionDeadlines = new Map(deadlineRows.map((r) => [r.package_id, r.deadline_min]));
```
Consumers unchanged: `milesSinceRefuel` (`twin-snapshot.ts:509,517`), `deadlineMin` (`twin-snapshot.ts:310-315`). **No golden change** — `simulate()` never calls `buildTwinSnapshot` (CONTEXT Area 1).

#### Tests — rebuild-equivalence (PERF-02 correctness)

**Analog:** `packages/projections/test/hub-inventory-cost.unit.test.ts` — the T-23-04 pattern. It builds a **counting in-memory fake `Kysely<ProjectionDb>`** (`hub-inventory-cost.unit.test.ts:73-199`) that backs a table with a `Map` and instruments reads, then asserts (a) per-event read count is bounded (independent of state size) and (b) the key-scoped fold is **byte-identical** to the full-table pure-reducer fold via `canonicalRows` (`:259-270`) + `stateFromRows` (`:242-256`). For PERF-02, assert: incremental applier output `==` full `trailerFuelReducer`/induction reducer fold from `global_seq=0`, byte-identical. The DB-backed live==rebuilt witness is `api/test/projections-golden-replay.int.test.ts` (compares `serializeTwin`) — add both new tables to its surface.

---

### AREA 2 — PERF-03 (async-queue runtime plumbing, banned from core)

#### Vendor API surface — `vendor/async-queue/src/index.ts`

The class to wire (`vendor/async-queue/src/index.ts:24-57`, `.enqueue`/`.dequeue`/`.close`/`.size`/`.isFull`/`.isEmpty`):

```typescript
export class AsyncQueue<T = any> {           // ALWAYS parameterize <ConcreteType> — never leave <any> (no-explicit-any is enforced)
  constructor(maxSize = 1) { /* circular buffer, power-of-2 sized */ }
  async enqueue(item: T): Promise<void>      // BLOCKS the producer when count >= maxSize (backpressure)
  async dequeue(): Promise<T | undefined>    // BLOCKS the consumer when empty; returns undefined after close+drain
  close(): void                              // wakes blocked waiters; consumers may still drain remaining items
  get size(): number; get isFull(): boolean; get isEmpty(): boolean;
}
```
Package: `@alexanderfedin/async-queue` (`vendor/async-queue/package.json:2`), `"main": "dist/index.js"`, `"types": "dist/index.d.ts"`, `"build": "tsc"` (`:5,6,8`). It is CJS; repo is ESM → CONTEXT Area 2: add `vendor/*` to `pnpm-workspace.yaml`, depend on the package, ensure a `prepare`/build step produces `dist/` (gitignored), verify resolution once linked.

#### Seam (a) — `worker-client.ts` (bound the unbounded `pending` Map)

**Analog (self):** the unbounded growth site (`worker-client.ts:64-105`):

```typescript
const pending = new Map<number, { resolve; reject }>();   // worker-client.ts:66 — currently UNBOUNDED
const run: RunEpochFn = (epoch, input, weights) => {
  const id = nextId; nextId += 1;
  return new Promise<EpochResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });                 // grows with in-flight epochs
    worker.postMessage({ id, epoch, input, weights });    // worker-client.ts:103
  });
};
```
Wire a small `AsyncQueue<WorkerRequest>` so `run` `await queue.enqueue(...)` backpressures the live-loop instead of accumulating in-flight epochs. Preserve the existing reply-correlation (`worker.on("message")`, `:78-84`) and the `rejectAll` on error/exit (`:73-93`) — those guards must still drain/reject.

#### Seam (b) — `event-store/src/store.ts` (coalesce per-event INSERTs)

**Analog (self):** the per-event awaited INSERT loop inside the transaction (`store.ts:111-124`):

```typescript
let version = expectedVersion;
for (const event of validated) {
  version += 1;
  await trx.insertInto("events").values({ stream_id: streamId, version, event_type: event.type,
    data: JSON.stringify(event.payload), metadata: JSON.stringify({ schemaVersion: event.schemaVersion }),
    occurred_at: occurredAt }).execute();          // ONE round-trip per event
}
```
Coalesce into a multi-row `.values([...])` commit behind a bounded write queue (CONTEXT Area 2b). **Constraint:** `version` increments per event and the global-order lock (`lockGlobalOrder(trx)`, `:107`) + CAS (`casStreamVersion`, `:108`) must stay inside the same transaction — preserve append-order (the order test below witnesses it).

#### Seam (c) — `ws/snapshots.ts` (replace drop-based skip with per-client bounded queue)

**Analog (self):** the drop-based 256 KB skip (`snapshots.ts:685-728`) + the broadcast loop (`snapshots.ts:905`):

```typescript
export const BACKPRESSURE_BYTES = 256 * 1024;                       // snapshots.ts:691
export function shouldSendToSocket(socket): boolean {              // snapshots.ts:718-725 — the DROP gate
  if (socket.readyState !== WS_OPEN) return false;
  if (socket.bufferedAmount > BACKPRESSURE_BYTES) return false;    // ← DROPS the frame for this client
  return true;
}
function sendRawIfOpen(socket, payload) { if (shouldSendToSocket(socket)) socket.send(payload); }
// broadcast:
const wire = JSON.stringify(envelope);
for (const socket of clients) sendRawIfOpen(socket, wire);        // snapshots.ts:904-905
```
Replace with a per-client `AsyncQueue<string>`: broadcast `enqueue`s the wire string (`:905`); a per-socket consumer loop `dequeue`s and `await`s `socket.send` drain → true bounded-memory backpressure (CONTEXT Area 2c). The initial-connect snapshot path must NOT depend on this gate (Pitfall 4, noted `:713-716`).

#### `eslint.config.ts` — widen the DET-03 core ban

**Analog:** the OODA + coordinator DET-03 blocks (`eslint.config.ts:103-225`). The block already bans `@alexanderfedin/async-queue` + `kysely` for `packages/simulation/src/ooda/**` and `coordinator/**`, and the file header notes "the async-queue plumbing ban widens engine-side in Phase 27" (`:100-102`). **Add a third block** scoped to the full deterministic core `packages/simulation/src/**` (honoring `ignores: [".../**/*.test.ts"]`), copying the `no-restricted-imports` paths+patterns verbatim from `:106-134`:

```typescript
{
  files: ["packages/simulation/src/**/*.ts"],
  ignores: ["packages/simulation/src/**/*.test.ts"],
  rules: {
    "no-restricted-imports": ["error", {
      paths: [
        { name: "@alexanderfedin/async-queue", message: "DET-03: async-queue is runtime plumbing only — the simulation deterministic core stays synchronous + pure (Pitfall 5)." },
        // (kysely ban already exists per-subdir; keep parity)
      ],
      patterns: [{ group: ["*async-queue*"], message: "DET-03: async-queue is runtime plumbing only — the simulation deterministic core stays synchronous + pure." }],
    }],
  },
}
```
> `vendor/**` stays in ESLint `ignores` (the lib itself isn't linted; only our call sites are). CONTEXT Area 2.

#### Order-guarantee test (new)

No exact analog (greenfield). Contract (CONTEXT Area 2 "Order guarantee"): enqueue N monotonically-tagged items through a real handoff (one of the 3 seams), assert dequeue order == enqueue order. The queue must never reorder the event stream. Model the deterministic-assertion style on the determinism unit tests (single seeded run, exact expected values).

---

### AREA 3 — VIZ-15/16 (scale rendering)

#### `map/layers.ts` — Cluster + declutter + VectorImageLayer

**Analog (self):** all layers are plain `VectorLayer` today. `createHubLayer` (`layers.ts:40-59`) is the swap target:

```typescript
export function createHubLayer(hubs: readonly HubDto[]): Layer {
  const source = new VectorSource({ useSpatialIndex: true });
  for (const hub of hubs) {
    const feature = new Feature({ geometry: new Point(fromLonLat([hub.lon, hub.lat])),
      hubId: hub.hubId, name: hub.name, volumeBucket: 0, slaRiskBucket: 0, congestionBucket: 0 });
    feature.setId(`hub:${hub.hubId}`);
    source.addFeature(feature);
  }
  const layer = new VectorLayer({ source, style: hubStyle });   // ← becomes Cluster + VectorImageLayer({declutter:true})
  return { layer, source };
}
```
VIZ-15 (per UI-SPEC): wrap the **spoke** source in `ol/source/Cluster({ distance: 40, minDistance: 20 })` on a `VectorImageLayer({ declutter: true })`; keep **centers** on their own un-clustered Tier-1 layer (a center is never absorbed into a spoke cluster). **Do NOT cluster trailers** — they animate via postrender (`createTrailerLayer`, `layers.ts:90-94` stays a plain VectorLayer). Cluster bubble style: slate-700 `#334155` disc, white count, radius 14→22 log-bucketed into ≤4 cached sizes (zero per-cluster alloc).

**Suggestion overlay layer** — clone the transient-flash pattern: `createInductionLayer` (`layers.ts:249-253`) + `flashInduction` (`layers.ts:261-279`):

```typescript
export function createInductionLayer(): Layer {
  const source = new VectorSource({ useSpatialIndex: true });
  const layer = new VectorLayer({ source, style: inductionStyle });
  return { layer, source };
}
export function flashInduction(source, inductionHubId, lon, lat, durationMs = 2000): void {
  const featureId = `induction:${inductionHubId}:${Date.now()}:${Math.random()}`;  // Date.now/Math.random = id uniqueness ONLY (sanctioned)
  const feature = new Feature({ geometry: new Point(fromLonLat([lon, lat])), inductionHubId });
  feature.setId(featureId); source.addFeature(feature);
  setTimeout(() => { const f = source.getFeatureById(featureId); if (f !== null) source.removeFeature(f); }, durationMs);
}
```
For VIZ-17: `createSuggestionLayer` + `flashSuggestion` (durationMs default ~2500 per UI-SPEC) with `declutter: true` on the layer.

#### `map/coloring.ts` — tier-branched cached style fns (VIZ-16)

**Analog (self):** the cached-style precedence pattern in `hubStyle` (`coloring.ts:119-133`, duty → volume → default) and `routeStyle` (`coloring.ts:205-219`, risk → load → default):

```typescript
export function hubStyle(feature: FeatureLike): Style {
  const duty: unknown = feature.get("dutyBucket");
  if (typeof duty === "number" && duty >= 0 && duty < HUB_DUTY_STYLE_CACHE.length) return HUB_DUTY_STYLE_CACHE[duty] as Style;
  const b: unknown = feature.get("volumeBucket");
  if (typeof b === "number" && b >= 0 && b < HUB_STYLE_CACHE.length) return HUB_STYLE_CACHE[b] as Style;
  return HUB_STYLE_DEFAULT;
}
```
Style cache is pre-allocated at module load (`coloring.ts:66-76`). VIZ-16 (per UI-SPEC): branch on `tier` FIRST, then fall through to the existing bucket logic — add a pre-allocated `Style` per (tier × bucket) cell. Center = radius 20 + amber `#f59e0b` 3px ring; spoke = radius 12 + white 2px ring; keep `volumeBucket`/`dutyBucket` fill ramp (tier encoded by size+ring, NOT hue). `routeStyle`: backbone leg = `#cbd5e1` 4px opacity 0.9; spoke leg = 2px opacity 0.55. Extend the `HUB_COLORS`/`*_LABELS` single-source-of-truth arrays (`coloring.ts:48-63`) for the Legend.

#### `map/suggestionColoring.ts` (new) — clone `inductionColoring.ts`

**Analog:** `packages/web/src/map/inductionColoring.ts` (whole file, 42 lines) — single pre-allocated `Style`, zero-per-frame `StyleFunction`:

```typescript
const INDUCTION_STYLE_DEFAULT = new Style({
  image: new CircleStyle({ radius: INDUCTION_RADIUS, fill: new Fill({ color: INDUCTION_COLOR }),
    stroke: new Stroke({ color: "#ffffff", width: 2 }) }),
  text: new Text({ text: INDUCTION_GLYPH, font: EMOJI_FONT }),
});
export function inductionStyle(): Style { return INDUCTION_STYLE_DEFAULT; }
```
VIZ-17 (per UI-SPEC): TWO pre-allocated styles — accept (green `#16a34a` fill, glyph `✓`) / reject (red `#dc2626` fill, glyph `✕`), radius 13, white 2px stroke. `suggestionStyle(feature)` branches on an `outcome` feature prop.

#### `envelope.ts` — DTO additions (HubState tier, RouteState backbone, TickPayload.suggestions)

**Analog (self):** `HubState` (`envelope.ts:88-107`), `RouteState` (`envelope.ts:110-114`), the additive-optional pattern (the `driverCount?`/`onBreakCount?` fields on `HubState`), `InductionEvent` (`envelope.ts:135-142`), and `TickPayload` (`envelope.ts:222-258`):

```typescript
export interface RouteState { readonly id: string; readonly loadBucket: number; readonly slaRiskBucket: number; }
// add: readonly isBackbone?: boolean;   (ADDITIVE + OPTIONAL — back-compat, same convention as HubState driverCount?)

// TickPayload — mirror inductionEvents (TRANSIENT, tick-only, NEVER on SnapshotPayload — Pitfall 7):
readonly inductionEvents?: readonly InductionEvent[];   // envelope.ts:250
// add: readonly suggestions?: readonly SuggestionEvent[];   (new transient field; SnapshotPayload comment at :216 forbids adding it there)
```
> `kind`/`tier` go on the **REST hub DTO** (static topology fetched once on map init, `MapView.tsx:267`), NOT on `HubState` over ws — CONTEXT Area 3: hub/route geometry is sent once via REST. `diffTick` (`envelope.ts:344`) handles tick deltas; the new `suggestions` field is attached onto the delta the same way `inductionEvents` is (`snapshots.ts:885-892`).

#### `app.ts` / `queries.ts` — static-topology DTO tier fields

**Analog (self):** `GET /hubs` map (`app.ts:26-34`) and `RouteDto` (`queries.ts:64-69`):

```typescript
// app.ts:8 + :28-33 — add kind/tier sourced from network/centers.ts isCenter:
export type HubDto = Hub;                                  // extend with kind: "center"|"spoke"; tier?: number
return rows.map((r) => ({ hubId: r.hub_id, name: r.name, lat: r.lat, lon: r.lon /* + kind, tier */ }));

// queries.ts:64-69 — add isBackbone sourced from the backbone leg set (buildBackbone in network/centers.ts):
export interface RouteDto { readonly routeId: string; readonly fromHubId: string; readonly toHubId: string;
  readonly geometry: readonly LonLat[]; /* + readonly isBackbone: boolean */ }
```
Source: `packages/simulation/src/network/centers.ts` — `isCenter` / `pickRegionalCenters` (`:102`), `buildBackbone` (`:206`) producing directed `"<from>-><to>"` backbone leg ids (`:288-289`).

---

### AREA 3 — VIZ-17 (suggestion feed pipeline, clone AlertFeed)

#### `useSuggestions.ts` (new hook) — clone `useAlertFeed`

**Analog:** `useAlertFeed` (`AlertFeed.tsx:124-152`) + the pure helpers `applyExceptionsNew`/`applyExceptionsResolved`/`sortFeed` (`AlertFeed.tsx:51-93`) + `MAX_FEED_ENTRIES = 200` cap (`AlertFeed.tsx:40`):

```typescript
export function useAlertFeed(): AlertFeedState {
  const [entries, setEntries] = useState<readonly FeedEntry[]>([]);
  const onExceptionsNew = useCallback((items) => setEntries((prev) => applyExceptionsNew(prev, items)), []);
  const onExceptionsResolved = useCallback((ids) => setEntries((prev) => applyExceptionsResolved(prev, ids)), []);
  return { feed: sortFeed(entries), onExceptionsNew, onExceptionsResolved };
}
```
`useSuggestions` mirrors this: same `MAX_FEED_ENTRIES = 200` cap, newest-first `sortFeed`, dedup-by-id append. Export pure helpers for Node unit tests (same pattern, `AlertFeed.tsx:18-21`).

#### `SuggestionFeed.tsx` (new component) — clone `AlertFeed`

**Analog:** the `AlertFeed` component (`AlertFeed.tsx:172-208`) — empty state + entry list, all text via React default escaping (NO `dangerouslySetInnerHTML`, T-05-16):

```tsx
export function AlertFeed({ feed }: AlertFeedProps): React.JSX.Element {
  if (feed.length === 0)
    return <div className="alert-feed"><div className="alert-feed__empty">No active exceptions</div></div>;
  return (<div className="alert-feed">{feed.map((entry) => (
    <div key={entry.id} className={`alert-feed__entry ${severityClass(entry.severity)}`}>
      <div className="alert-feed__entry-header"><span className="alert-feed__kind">{kindLabel(entry.kind)}</span>...</div>
      <div className="alert-feed__reason">{entry.reason}</div>
      <div className="alert-feed__action">{entry.recommendedAction}</div>
    </div>))}</div>);
}
```
Per UI-SPEC: reuse `.alert-feed__*` CSS classes 1:1 (visual sibling of Live Exceptions). Empty state "No active suggestions". Accept rows green `#4ade80` text; reject rows reuse `COORDINATION_REJECT_LABELS` verbatim (see P27-B) red `#f87171` text. Kind labels Title Case (mirror `kindLabel`, `AlertFeed.tsx:107-118`).

#### `App.tsx` — dispatch suggestions

**Analog (self):** `onAlertEnvelope` (`App.tsx:56-72`):

```typescript
const onAlertEnvelope = useCallback((envelope: WsEnvelope): void => {
  if (envelope.type === "snapshot") {
    if (envelope.payload.exceptionsOpen.length > 0) onExceptionsNew(envelope.payload.exceptionsOpen);
  } else {
    if (envelope.payload.exceptionsNew !== undefined) onExceptionsNew(envelope.payload.exceptionsNew);
    if (envelope.payload.exceptionsResolved !== undefined) onExceptionsResolved(envelope.payload.exceptionsResolved);
    // ADD: if (envelope.payload.suggestions !== undefined) onSuggestions(envelope.payload.suggestions);  (tick-only)
  }
}, [onExceptionsNew, onExceptionsResolved]);
```
Suggestions are tick-only (the `else`/tick branch only), never on the snapshot branch — Pitfall 7.

#### `RightRail.tsx` — add the feed section

**Analog (self):** the Live Exceptions `<section>` (`RightRail.tsx:80-94`):

```tsx
<section className="right-rail__section right-rail__section--feed">
  <header className="right-rail__section-header">
    <h2 className="right-rail__section-title">Live Exceptions
      {feed.length > 0 && <span className="right-rail__badge">{feed.length}</span>}</h2>
  </header>
  <div className="right-rail__feed-scroll"><AlertFeed feed={feed} /></div>
</section>
```
Clone for "Advisory Suggestions" (count badge mirrors the exception badge); gate visibility on the opt-in "Suggestions" toggle (default OFF, blue accent ON — place near `SpeedControl`, `RightRail.tsx:77`).

---

### AREA 4 — P27-A (optimizer-divergent reroute — CHANGES the optimizer-on golden)

#### `engine.ts optimizerRerouteFor` — the 3 structural pins to change

**Analog (self):** `optimizerRerouteFor` (`engine.ts:2410-2531`). The three pins CONTEXT names, with exact lines:

```typescript
// PIN 2 — always-actionable departure (engine.ts:2476): replace FREEZE+1 with the trailer's REAL scheduled departure
departureOffsetMin: COORDINATOR_OPTIMIZER_FREEZE_WINDOW_MIN + 1, // past freeze ⇒ actionable  ← derive from real schedule

// PIN 1 — route head pinned to obs.centerId (engine.ts:2481-2484): give a REAL destination choice (alternate uncongested cross-dock hubs)
routeStops: [
  { hubId: obs.centerId, stopIndex: 0 },   // ← center is statically the head; the translator reads route[0] (always the center)
  { hubId: trip.toHubId, stopIndex: 1 },
],

// PIN 3 — no real load/capacity (engine.ts:2485): populate real blocks + per-leg capacity/travelMin/distanceMiles from fold state
blocks: [],                                 // ← empty ⇒ optimizer can never DECLINE on capacity/LIFO; constant capacity 50 at :2477
```
The route legs are built only center↔hub (`engine.ts:2494-2509`) with `COORDINATOR_OPTIMIZER_*` constants. CONTEXT Area 4: build multiple candidate relief legs (center AND alternate uncongested cross-dock hubs from the partitioned slice); populate real `blocks` + per-leg `capacity`/`travelMin`/`distanceMiles` so the optimizer can decline an infeasible reroute. `runEpoch` itself unchanged (`engine.ts:2522-2526`).

#### `coordinator/optimize.ts` — read the optimizer's CHOSEN next hub

**Analog (self):** `epochResultToRerouteSuggestions` (`optimize.ts:186-223`). The pin to change is the next-hub derivation (`optimize.ts:191-197`):

```typescript
// CURRENT (the bug): optimizer next hub = the STATIC twin route head (route[0]) — always obs.centerId,
// so it can only ever endorse "reroute back to center" (the documented coincidence).
const optimizerNextHubByTrailer = new Map<string, string>();
for (const trailer of twin.trailers) {
  const head = trailer.route[0];                          // optimize.ts:195 — STATIC head, not the routed choice
  if (head !== undefined) optimizerNextHubByTrailer.set(trailer.trailerId, head.hubId);
}
```
CONTEXT Area 4: read the optimizer's **actually-chosen** next hub from the routed `EpochResult` (not the static `route[0]`). `buildCenterTwinFromFold` (`optimize.ts:104-154`) already supports `distanceMiles` on legs (`:128`) and carries `blocks` through (`:145-149`) — wire real fold-state values into the `CenterFoldRouteLeg`/`CenterFoldTrailer` slices (the `optionalDistanceMiles` + `blocks` fields, `:50-54,66-67`). The 3-gate emit (feasible+!frozen / has-current-next / differs) at `optimize.ts:201-217` stays — with real feasibility it will now genuinely DECLINE infeasible reroutes.

#### `coordinator-optimizer-determinism.unit.test.ts` — flip equality → divergence + NEW golden

**Analog (self):** the documented-equality assertion (`coordinator-optimizer-determinism.unit.test.ts:143-146`) to flip:

```typescript
// CURRENT (to flip): the golden EQUALS edfa5a6d…
it("the optimizer-on golden EQUALS the Phase-25 coordinator golden edfa5a6d… (documented coincidence)", () => {
  expect(COORDINATOR_OPTIMIZER_ON_GOLDEN_SHA256).toBe(COORDINATOR_ON_GOLDEN_SHA256);   // :144
  expect(sha(simulate(COORDINATOR_OPTIMIZER_ON_OPTS))).toBe(COORDINATOR_ON_GOLDEN_SHA256);  // :145
});
```
After P27-A: capture a NEW `COORDINATOR_OPTIMIZER_ON_GOLDEN_SHA256` (`:111-112`) **reproducibility-first** (the protocol documented `:92-95`: run twice in-process ⇒ equal AND across two separate `node` processes ⇒ equal, BEFORE baking the literal). Flip the assertion to **DIFFERS** from `edfa5a6d…` AND `3920accc…`/`94689f99…` (the `:148-154` "DIFFERS" test already exists for the latter two — extend it to also differ from `COORDINATOR_ON_GOLDEN_SHA256`). The three prior goldens `3920accc`/`edfa5a6d`/`94689f99` (`:117-122`) stay INTACT. The reroute-count assertion (`:176-181`, currently `reroute === 9553`) will change — recapture the post-guard counts.

---

### AREA 4 — P27-B (live reject-with-reason — DEMO-CONFIG-ONLY, no baked golden)

#### `main.ts` — continental demo fuel/HOS config (option 1, chosen)

**Analog (self):** the live-demo fuel config literal (`main.ts:63-64`) + `DEFAULT_FUEL_CONFIG` (`domain/src/fuel.ts:47-53`):

```typescript
// main.ts:63-64 — the ONLY change site for P27-B (demo config, not engine defaults, not goldens):
const fuelEnabled = resolveDemoFuelEnabled();
const fuelConfig: FuelConfig = { ...DEFAULT_FUEL_CONFIG, enabled: fuelEnabled };
//                              ↑ override refuelThresholdMiles (and/or tighten maxDriveMin via hosConfig)

// domain/src/fuel.ts:47-53 — the default being spread (do NOT edit this; override at the demo site):
export const DEFAULT_FUEL_CONFIG: FuelConfig = {
  enabled: false, tankCapacityGallons: 150, milesPerGallon: 6.5,
  refuelThresholdMiles: 1200, refuelTimeMinutes: 30,
};
```
CONTEXT Area 4 (option 1): in the **continental demo config only**, enable fuel + lower `refuelThresholdMiles` (and/or tighten `maxDriveMin`) so a long backbone leg deterministically pushes a mid-trip truck past the refuel/HOS limit exactly when it's behind a congested hub the reroute rule already targets → the "won't divert: HOS/fuel" reject fires live. **Deterministic** (no clock/RNG). Do NOT take the targeting-heuristic path (option 2) — it would move goldens. The continental short-run test (`continental-determinism.unit.test.ts`, seed-42/300) tests *difference* not a frozen hash, so no baked-golden recapture (CONTEXT specifics).

**The reject is already fully rendered (no UI work for P27-B):**
- `coordinator/observe.ts:46-53` (`ObservedTruck` — queue-depth-only signal today) + the rule that fires a reroute.
- A rerouted truck declines on its own feasibility → `SuggestionRejected` event → `coordination-rejected` exception row (`exceptions.ts:242-257`):
  ```typescript
  case "SuggestionRejected": {
    const p = event.payload;
    return open(state, { exceptionId: coordinationRejectId(p.suggestionId), kind: "coordination-rejected",
      severity: "warning", recommendedAction: COORDINATION_REJECT_LABELS[p.reasonCode],
      reasonCode: p.reasonCode, label: COORDINATION_REJECT_LABELS[p.reasonCode], /* ... */ });
  }
  ```
- Reject labels (single source of truth, reuse verbatim in VIZ-17 too) — `exceptions.ts:54-61`:
  ```typescript
  export const COORDINATION_REJECT_LABELS = { hos: "won't divert: HOS", fuel: "won't divert: fuel",
    dock: "won't dispatch: dock full", infeasible: "declined: infeasible" } as const;
  ```
- Wired to the `blockedFreight` wire kind for the alert feed — `exceptionKindToWire` (`snapshots.ts:416-431`): `case "coordination-rejected": return "blockedFreight";` → `AlertFeed.tsx:202` renders the reason/action.

---

## Shared Patterns

### Key-scoped incremental projection fold (PERF-02)
**Source:** `packages/projections/src/runner/inline.ts:116-129` (the doc-comment contract) + `applyPackageLocation` (`:145-191`).
**Apply to:** both new appliers (`trailer-fuel`, `induction-deadline`).
Load ONLY the affected key(s) → fold with the SAME pure reducer → persist exactly the delta (upsert changed rows, DELETE removed). Cost is O(affected keys), byte-identical to a full-table fold / rebuild-from-0 (FND-04, P5a).

### Persisted-index reuse for fold state (PERF-02)
**Source:** `packages/projections/src/runner/catchup.ts:177-194` (`loadGeoTrackState` reading `geo_route` + `geo_inflight_trip`).
**Apply to:** the `trailer-fuel` applier (its reducer needs `routes` + `inflight` — read the already-persisted tables instead of re-scanning).

### Reproducibility-first golden capture (P27-A)
**Source:** `coordinator-optimizer-determinism.unit.test.ts:92-95` (the `sha` helper `:58-59` + the in-process-twice + two-separate-node-processes protocol).
**Apply to:** the new optimizer-on golden. Never commit a non-reproducible literal (PITFALLS).

### Cached zero-per-frame OL Style (VIZ-15/16/17)
**Source:** `coloring.ts:66-76` (pre-allocated `STYLE_CACHE`) + `inductionColoring.ts:25-41` (single cached Style).
**Apply to:** tier×bucket hub/route styles, cluster-bubble sizes, suggestion accept/reject styles. Mutate `feature.set(prop, ...)`; never `feature.setStyle(new Style(...))` per frame; never `source.clear()`.

### Transient tick-only flash (VIZ-17 + suggestions field)
**Source:** `layers.ts:261-279` (`flashInduction` add-then-`setTimeout`-remove) + `envelope.ts:245-258` + `snapshots.ts:885-892` (attach onto the delta, never the snapshot).
**Apply to:** the suggestion overlay marker + the `TickPayload.suggestions` field (Pitfall 7: never on `SnapshotPayload`).

### Feed pipeline (VIZ-17)
**Source:** `AlertFeed.tsx` (whole file) + `App.tsx:56-72` + `RightRail.tsx:80-94`.
**Apply to:** `useSuggestions` / `SuggestionFeed` / App dispatch / RightRail section. Reuse `MAX_FEED_ENTRIES = 200`, newest-first sort, dedup-by-id, `.alert-feed__*` CSS, React default escaping.

### DET-03 core import ban (PERF-03)
**Source:** `eslint.config.ts:103-225` (OODA + coordinator blocks).
**Apply to:** a new `packages/simulation/src/**` block banning `@alexanderfedin/async-queue` (+ kysely parity), with `*.test.ts` ignored and `vendor/**` ignored.

---

## No Analog Found

| File | Role | Data Flow | Reason / Source pattern |
|------|------|-----------|-------------------------|
| `pnpm-workspace.yaml` + vendor `dist/` build wiring (PERF-03) | config | — | No prior vendored-workspace package; follow `vendor/async-queue/package.json` `prepare`/`build` (`tsc`) + standard pnpm `workspace:*` dependency. |
| `async-queue-order.*.test.ts` (PERF-03) | test | — | No existing FIFO-order test; greenfield. Style: deterministic single-run assertion (mirror determinism unit tests). |

> Everything else has a precise in-repo analog (above). The two greenfield items are pure plumbing/build config with no behavioral analog.

## Metadata

**Analog search scope:** `packages/projections/{src,test}`, `packages/api/src/{optimizer,ws,routes,sim}`, `packages/api/test`, `packages/event-store/src`, `packages/simulation/src/{engine.ts,coordinator,network}`, `packages/simulation/test`, `packages/domain/src/fuel.ts`, `packages/web/src/{map,panels,App.tsx}`, `vendor/async-queue`, `eslint.config.ts`.
**Files scanned:** ~30 source files read (targeted ranges).
**Pattern extraction date:** 2026-06-26
