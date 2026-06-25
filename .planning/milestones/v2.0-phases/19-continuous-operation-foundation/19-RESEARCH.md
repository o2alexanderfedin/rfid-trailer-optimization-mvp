# Phase 19: Continuous Operation Foundation - Research

**Researched:** 2026-06-24
**Domain:** Discrete-event simulation engine — open-ended loop, bounded-memory infrastructure, long-run determinism
**Confidence:** HIGH (all 12 verification questions answered from live codebase reads with exact file:line citations)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **Open-ended loop is a control-flow change, not an architecture change.** Replace the `if (action.fireTick > durationTicks) break` hard ceiling in `generate()` with a `stopped`/`runUntilStopped` opt-in. The existing `durationTicks` path stays **unchanged** so every existing golden is byte-identical.
- **Streaming emit.** Convert `generate()`'s `out: SimulatedEvent[]` accumulation to an `onEvent` callback for the live-run path; keep the array-collecting `simulate()` wrapper for golden tests.
- **Determinism keystone (DET-01/02).** Every v2.0 feature opt-in; flags-off => byte-identical existing seed-42 golden. A **10,000-tick** seeded golden hash test must pass and be cross-architecture stable (x86 + ARM). If it diverges, replace the log-normal sampler with an integer lookup table.
- **Bounded memory (CONT-04).** Three mechanisms, all Phase-19:
  1. `projection_checkpoints` watermark — catch-up resumes from last applied global seq.
  2. WS backpressure — `socket.bufferedAmount` guard (skip/coalesce ticks above 256 KB).
  3. Optimizer idempotency LRU — bound the in-memory `(epoch, scopeHash)` map at ~500 entries.
- **Bidirectional route registration at bootstrap** — `buildRoutes()` emits `RouteRegistered` for BOTH directions (reverse geometry = existing polyline coordinates reversed, no new ORS call).

### Claude's Discretion
- Exact stop-signal shape (`runUntilStopped: boolean` option + an external `stop()` handle vs an injected `shouldStop()` predicate) — choose the simplest that preserves determinism and testability (DIP).
- Sort-wave cadence shape for CONT-05 (P2) — a deterministic schedule seeded from the existing stream; must be flag/config-gated and must not perturb goldens when disabled.
- `sim-day` / cycle counter representation in the ws state diff + UI placement (CONT-03) — follow the existing ws envelope + React panel conventions.
- Watermark checkpoint cadence (every N events / every tick-batch) — pick a value that keeps rebuild bounded without excessive writes.

### Deferred Ideas (OUT OF SCOPE)
- Postgres event-log snapshotting/partitioning/compaction.
- Persistent optimizer idempotency table (Phase 21).
- Detection `is_active` scoping benchmark (Phase 21).
- CONT-FUT-01 pacer safety valve for sustained high-speed runs.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CONT-01 | Simulation runs open-ended until explicitly stopped; existing finite `durationTicks` path preserved | VQ#1: stop condition is a single `if (action.fireTick > durationTicks) break` at engine.ts:1231 — direct surgical replacement |
| CONT-02 | Freight generation sustains indefinitely across multiple day/cycle periods via self-rescheduling | VQ#1: package rescheduling at engine.ts:722-723 is already guarded by `nextTick <= durationTicks`; remove the guard for open-ended path |
| CONT-03 | Sim-day / cycle counter exposed in ws state diff and operator UI | VQ#7: ws envelope has `simMs` field; derive `simDay = floor((simMs - EPOCH_MS) / MS_PER_DAY)` from deterministic virtual clock |
| CONT-04 | Bounded memory — watermark checkpoint, ws backpressure, optimizer LRU | VQ#6: `projection_checkpoints` table already exists. VQ#7: no bufferedAmount guard yet. VQ#8: memo Map is unbounded |
| CONT-05 (P2) | Sort-wave / cut-off burst-quiet-burst departure pattern | Flag-gated; must not perturb goldens when off |
| DET-01 | Every v2.0 feature opt-in; flags-off => byte-identical existing seed-42 golden | VQ#3: RNG unchanged. VQ#1: durationTicks path unchanged |
| DET-02 | 10,000-tick seeded run produces byte-identical event hash cross-architecture | VQ#9: existing golden uses `simulate()` + JSON.stringify; new 10k golden uses same pattern |
</phase_requirements>

---

## Summary

Phase 19 is a **pure control-flow and infrastructure change** to three packages: `@mm/simulation`, `@mm/api`, and `@mm/optimizer`. Zero new domain events, zero new Postgres tables beyond those already in the schema. The codebase is in an excellent state for this phase — most of the infrastructure the phase needs already exists.

**The most surprising finding** is that `projection_checkpoints` is already fully implemented in the codebase, including `runCatchup` which already reads from a per-projection watermark rather than from `0n` (catchup.ts:159-160). The CONTEXT.md claim that driver.ts contains a `readAll(db, 0n)` full-from-0 rebuild is **WRONG for the catch-up projections**. That pattern only applies to the inline projection cursor (`let cursor = 0n` at driver.ts:349), which is a per-run session cursor (reset on process restart) — not a rebuild. This is a critical nuance: the watermark checkpoint for `runCatchup` already exists; what does NOT exist is a persistent session cursor so that an inline projection rebuild after restart picks up from the last persisted checkpoint instead of from seq=0.

**The second most important finding** is that `buildRoutes()` at routes.ts:283-306 **already emits both directions** (center→spoke AND spoke→center). Every spoke gets a directed pair. The CONTEXT.md's "bidirectional route registration" task is partially pre-done — routes are already registered in both directions. The Phase 19 task reduces to: verify BOTH directed `RouteRegistered` events land correctly in the event store, and confirm the reverse polyline geometry is the coordinate-reversed outbound polyline.

**Primary recommendation:** The open-ended loop change is ~12 LOC. The streaming-emit change is ~20 LOC. The real work in this phase is (1) the ws backpressure guard (~15 LOC but needs careful placement), (2) the optimizer LRU (~30 LOC), (3) the 10k-tick golden test, and (4) adding `simDay` to the ws envelope. Total phase is smaller than CONTEXT.md implies, which is good.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Open-ended run loop / stop-signal | `@mm/simulation` engine | `@mm/api` sim-driver | Engine owns the `generate()` loop; driver controls when to start/stop |
| Streaming `onEvent` callback | `@mm/simulation` engine | — | `generate()` is the single event source; callback is an engine API surface |
| Package self-rescheduling (CONT-02) | `@mm/simulation` engine | — | `createPackageBatch` reschedule is already in engine; remove the `durationTicks` guard |
| Sim-day counter (CONT-03) | `@mm/api` ws layer | `@mm/web` UI | Derived from `simMs` in the ws broadcast path; UI renders it |
| Projection watermark (CONT-04a) | `@mm/projections` catchup | `@mm/api` driver | `projection_checkpoints` already exists; driver must use checkpoint on rebuild after restart |
| WS backpressure (CONT-04b) | `@mm/api` ws/snapshots | — | `sendRawIfOpen` is the send path; guard goes here |
| Optimizer idempotency LRU (CONT-04c) | `@mm/api` rolling-service | — | `this.memo` Map in `RollingOptimizerService` |
| Bidirectional route registration | `@mm/simulation` routes | — | `buildRoutes()` already emits both directions |
| 10k-tick determinism golden (DET-02) | `@mm/simulation` test | — | New test in `test/determinism.unit.test.ts` |
| Salt-collision assertion | `@mm/simulation` test | — | Already in `test/fuel-determinism.unit.test.ts`; expand when new salts land in Phase 20 |

---

## Verification Question Answers

### VQ#1 — Engine stop condition, `generate()` accumulation, wrappers

**Exact stop condition** (`packages/simulation/src/engine.ts:1227-1234`):
```typescript
for (;;) {
  const action = queue.pop();
  if (action === undefined) break;           // queue empty
  if (action.fireTick > durationTicks) break; // TIME CEILING — line 1231
  clock.advance(action.fireTick - currentTick(clock));
  action.run();
}
```

The single stop condition is `action.fireTick > durationTicks` at **line 1231**. It is a `>` (strictly greater than), not `>=`. Actions AT `durationTicks` fire; actions AFTER do not.

**Out-array accumulation** (`engine.ts:382, 460-462`):
```typescript
const out: SimulatedEvent[] = [];
// ...
const emit = (streamId: string, event: DomainEvent): void => {
  out.push({ streamId, event, occurredAt: clock.nowIso() });
};
```
`out` is a single flat array accumulated by all `emit()` calls. It is returned at `generate()` line 1236: `return out`.

**Wrappers** (`engine.ts:1251-1266`):
- `simulate(opts)` at line 1251 — calls `generate(opts)` and returns the array directly. This is the golden-test surface.
- `runSimulation(opts)` at line 1261 — calls `generate(opts)`, then iterates the array calling `await opts.sink(item)` sequentially. This is the store-driven surface.

**Where an `onEvent` callback would hook in:** Replace `out.push(...)` in the `emit()` closure (line 461) with an `opts.onEvent?.(item) ?? out.push(item)` branch. The `simulate()` wrapper keeps the `out[]` accumulation; a new `runUntilStopped` path passes an `onEvent` callback instead. The `runSimulation` wrapper can be refactored similarly or kept as-is (it already iterates the full array synchronously).

**Self-rescheduling guards that need updating** (two places):
- `createPackageBatch` at **line 723**: `if (nextTick <= durationTicks) schedule(nextTick, ...)`
- `arriveTrailer` at **line 1166**: `if (nextDepart <= durationTicks) { schedule(nextDepart, ...) }`

Both guards must become no-ops (or removed) for the `runUntilStopped` path to keep events flowing beyond the original ceiling. They MUST remain for the finite path (golden safety).

**CORRECTION to CONTEXT.md:** There is no `runSimulation()` wrapper that is "already partially present as `runSimulation()`" — both `simulate()` and `runSimulation()` are fully present and separate. The comment in CONTEXT was accurate; the reading here confirms both wrappers exist as described at lines 1251 and 1261.

[VERIFIED: packages/simulation/src/engine.ts lines 1227-1266]

---

### VQ#2 — EventQueue same-tick tie-break (MOST CRITICAL DETERMINISM CHECK)

**FINDING: The tie-break IS already deterministic. No new task needed — only a verification test.**

The `EventQueue` class at **engine.ts:247-275** uses an `(fireTick, seq)` comparator:

```typescript
// engine.ts:265-274 — the sort comparator
pop(): Scheduled | undefined {
  if (this.items.length === 0) return undefined;
  if (this.dirty) {
    this.items.sort((a, b) =>
      a.fireTick !== b.fireTick ? a.fireTick - b.fireTick : a.seq - b.seq,
    );
    this.dirty = false;
  }
  return this.items.shift();
}
```

The `seq` is a monotonic insertion counter allocated by `claimSeq()` at **engine.ts:253-257**:
```typescript
claimSeq(): number {
  const seq = this.nextSeq;
  this.nextSeq += 1;
  return seq;
}
```

Every `schedule()` call at **engine.ts:1213-1215** allocates a seq atomically:
```typescript
function schedule(fireTick: number, run: () => void): void {
  queue.push(fireTick, queue.claimSeq(), run);
}
```

**Verdict:** The tie-break is fully deterministic via monotonic insertion sequence. Any two actions at the same `fireTick` are ordered by the order `schedule()` was called. Since `generate()` is single-threaded (no async, no Promise, no setInterval), the schedule order is fully reproducible per seed. The Google AI Mode consult item #2 (same-timestamp tie-break) is **already satisfied** — the plan needs a verification test confirming this, NOT an implementation task.

**What the plan needs:** A unit test asserting that two events scheduled at the same tick always fire in insertion order (and that the resulting stream is byte-identical across runs). This is a test task, not an implementation task.

[VERIFIED: packages/simulation/src/engine.ts lines 247-275, 1212-1215]

---

### VQ#3 — `rng.ts`: RNG implementation

**mulberry32 confirmed** (`packages/simulation/src/rng.ts:40-51`):
```typescript
export function makeRng(seed: number): Rng {
  let state = mixSeed(seed);
  const next = (): number => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };
  // ...
}
```

**splitmix32 confirmed** (`rng.ts:30-35`):
```typescript
function mixSeed(seed: number): number {
  let z = (seed >>> 0) + 0x9e_37_79_b9;
  z = Math.imul(z ^ (z >>> 16), 0x21_f0_aa_ad);
  z = Math.imul(z ^ (z >>> 15), 0x73_5a_2d_97);
  return (z ^ (z >>> 15)) >>> 0;
}
```

**XOR-salt sub-seeding** (`engine.ts:320-345`):
```typescript
const rfidRng    = makeRng((seed ^ RFID_RNG_SALT) >>> 0);
const overCarryRng = makeRng((seed ^ OVER_CARRY_RNG_SALT) >>> 0);
const timingRng  = makeRng((seed ^ TIMING_RNG_SALT) >>> 0);
const hosRng     = makeRng((seed ^ HOS_RNG_SALT) >>> 0);
const fuelRng: Rng | undefined = fuelOn ? makeRng((seed ^ FUEL_RNG_SALT) >>> 0) : undefined;
```

**Conclusion:** Do NOT touch `rng.ts`. The 960+ existing goldens depend on this exact implementation. All new salts (INDUCTION_RNG_SALT for Phase 20, OUTBOUND_RNG_SALT for Phase 22) follow the same `seed ^ SALT` pattern.

[VERIFIED: packages/simulation/src/rng.ts:1-68, engine.ts:315-346]

---

### VQ#4 — The 6 seeded substream salts and the existing salt-collision assertion test

**Six salt constants** (`engine.ts:71-93`):
```
RFID_RNG_SALT      = 0x5f_1d_a7_c3   (line 71)
OVER_CARRY_RNG_SALT = 0x3c_a7_1d_5f  (line 73)
TIMING_RNG_SALT    = 0x00_00_77_17   (line 75)
HOS_RNG_SALT       = 0x10_51_09_01   (line 82)
FUEL_RNG_SALT      = 0x2b_3d_91_e7   (line 93)
```

Wait — that is only **5 salts**, not 6. The primary `rng = makeRng(seed)` uses no XOR salt at all (it IS the base stream). So there are 5 NAMED salt constants + 1 unnamed base stream = 6 substreams total.

**Salt-collision assertion test location:**
- `packages/simulation/test/fuel-determinism.unit.test.ts` — the MOST CURRENT test, asserts all 5 named salts are pairwise-distinct (`new Set(salts).size === 5`). Lines 43-56.
- `packages/simulation/test/hos-determinism.unit.test.ts` — earlier version, asserts 4 salts (rfid/overCarry/timing/hos). Lines 32-43.

**The plan task:** When Phase 20 adds `INDUCTION_RNG_SALT`, extend the test in `fuel-determinism.unit.test.ts` (or a new `v2-salts.unit.test.ts`) to cover 6 salts. Phase 19 itself adds NO new salts — it only establishes the discipline. The Phase 19 verification task is to ensure the existing 5-salt test passes unchanged.

[VERIFIED: engine.ts:71-93, fuel-determinism.unit.test.ts:43-56, hos-determinism.unit.test.ts:32-43]

---

### VQ#5 — `buildRoutes()` geometry and bidirectional registration

**FINDING: `buildRoutes()` ALREADY emits BOTH directions. No implementation needed.**

`packages/simulation/src/network/routes.ts:283-306`:
```typescript
export function buildRoutes(hubs: readonly Hub[], geometry?: RoadGeometryFile): Route[] {
  if (hubs.length < 2) return [];
  const file = geometry ?? loadStaticRoadGeometry();
  const center = hubs[0]!;
  const routes: Route[] = [];
  for (let i = 1; i < hubs.length; i += 1) {
    const spoke = hubs[i]!;
    routes.push({
      routeId: routeId(center.hubId, spoke.hubId),
      fromHubId: center.hubId,
      toHubId: spoke.hubId,
      geometry: applyRoadGeometry(file, center, spoke, ROUTE_POINTS),  // center→spoke
    });
    routes.push({
      routeId: routeId(spoke.hubId, center.hubId),
      fromHubId: spoke.hubId,
      toHubId: center.hubId,
      geometry: applyRoadGeometry(file, spoke, center, ROUTE_POINTS),  // spoke→center
    });
  }
  return routes;
}
```

Both the center→spoke AND spoke→center `RouteRegistered` events are already emitted at bootstrap (`engine.ts:627-640`). The geometry for spoke→center is `applyRoadGeometry(file, spoke, center, ROUTE_POINTS)` — which is the road geometry for that directed leg (reversed relative to center→spoke, by construction, since `applyRoadGeometry` reads the `leg[routeId(spoke, center)]` key from the road file).

**Polyline geometry shape:** `geometry: readonly LonLat[]` where `LonLat = [number, number]` (`[lon, lat]` in GeoJSON axis order). The `ROUTE_POINTS = 24` interpolated vertices per leg.

**For the Phase 19 task:** The "bidirectional route registration" requirement is **already satisfied**. The plan task should be reduced to:
1. Write a test asserting the bootstrap emits `RouteRegistered` for BOTH directions of each leg.
2. Confirm the ws snapshot's `geo_route` table captures both legs (check `catchup.ts` `runGeoTrack` handler at line 259-260).

The `geo_route` table insert happens at `catchup.ts:224-239` (upsertRoute), called when `event.type === "RouteRegistered"` at line 258-261. It stores `(from_hub_id, to_hub_id)`, so spoke→center routes land correctly.

[VERIFIED: routes.ts:283-306, engine.ts:627-640, catchup.ts:258-261]

---

### VQ#6 — `driver.ts`: `runCatchup`, rebuild path, `projection_checkpoints`, event-log seq type

**CRITICAL CORRECTION to CONTEXT.md:** The CONTEXT claims `readAll(db, 0n)` is "the full-from-0 rebuild that the watermark checkpoint fixes." This is **NOT the catch-up projection path**. The `readAll(es, cursor)` calls in driver.ts (lines 385, 403, 575, 590) are the **inline projection** path, where `cursor` is a session-local bigint that tracks position within the CURRENT PROCESS RUN. This cursor IS initialized to `0n` (line 349/524) — meaning on every process restart, inline projections replay from seq=0 for that process's lifetime. That is expected behavior for a read-your-writes in-process cursor.

**The REAL `runCatchup` watermark:** `packages/projections/src/runner/catchup.ts:295-302` calls `runAuditTimeline` (line 299) and `runGeoTrack` (line 300), each of which reads `projection_checkpoints` at lines 67-71 and 159-160. These already read from their per-projection checkpoint — NOT from `0n`. The `projection_checkpoints` table is already in the event-store schema at `event-store/src/schema.ts:47-50, 112-114` (DDL: `BIGINT NOT NULL DEFAULT 0`).

**What the plan should actually fix:** The inline projection cursor `let cursor = 0n` in `driveSimulationPaced` (driver.ts:524) — on process restart this cursor resets to 0 and replays all events from the beginning for the INLINE projection folds (not catch-up projections). For an open-ended indefinite run, the process shouldn't restart mid-run, so this may not be a critical issue at Phase 19 scale. However, if the plan wishes to address it, the fix is: on startup, read `max(globalSeq)` from `events` as the initial cursor, since the inline projections are already up-to-date from the previous run (they use the same tables as catch-up projections).

**Event-log seq type:** `global_seq` is `BIGINT GENERATED ALWAYS AS IDENTITY` in Postgres DDL (schema.ts:98). In Kysely it is typed as `Generated<string>` (schema.ts:19) because the `pg` driver returns BIGINT as string. In application code it is used as `bigint` via `BigInt(row.last_seq)` (catchup.ts:71). The cursor in driver.ts is declared as `let cursor = 0n` — a JavaScript `bigint` literal.

**`projection_checkpoints` columns:** `(projection TEXT PRIMARY KEY, last_seq BIGINT NOT NULL DEFAULT 0)` (schema.ts:112-115). The `CatchupProjectionName` type enumerates valid projection names: `"audit-timeline"` and `"geo-track"` (schema.ts — `CATCHUP_PROJECTIONS` constant).

**How projections are applied per event:** `applyInline(proj, ev)` at driver.ts:389/579 dispatches to the inline reducers in `packages/projections/src/runner/inline.ts`. Catch-up projections use `auditTimelineReducer` and `geoTrackReducer` in catchup.ts.

[VERIFIED: driver.ts:349, 385, 403, 524, 575, 590; catchup.ts:62-87, 159-160; event-store/src/schema.ts:47-50, 98, 112-115]

---

### VQ#7 — `snapshots.ts`: `diffTick`, `buildSnapshot`, ws send path, `bufferedAmount`, sim-day counter

**`diffTick` location:** Imported from `./envelope.js` (snapshots.ts:22); not defined in snapshots.ts itself. The `diffTick` function lives in `packages/api/src/ws/envelope.ts`. The snapshots.ts file calls it at line 780: `const delta: TickPayload = diffTick(prev, current);`.

**`buildSnapshot`:** Not a standalone function in snapshots.ts. The equivalent is `buildSnapshotPayload(db)` defined at **snapshots.ts:436-642**. It reads from:
- `readGeoKeyframes(catchup)` — from `geo_keyframe` table (catch-up projection) — NOT the raw event log
- `readHubsFromLog(db)` — from the `events` table filtering `WHERE event_type = 'HubRegistered'` at queries.ts:194-209 — **THIS READS THE RAW EVENT LOG**
- `readOpenExceptions(proj)` — from `exceptions` table (inline projection)
- `hub_inventory` table (inline projection)
- `geo_route`, `geo_inflight_trip`, `trailer_state`, `driver_status` (inline projections)

**`readHubsFromLog` is a raw-log scan:** This is an O(HubRegistered events) scan. Since `HubRegistered` fires once per hub at bootstrap (10 hubs = 10 events), this is bounded and acceptable — hub registrations are a fixed-size set. Not the same scaling concern as scanning all `PackageArrivedAtHub` events.

**ws send path (`socket.send()`):** Located at **snapshots.ts:791** inside the `broadcast` closure:
```typescript
const wire = JSON.stringify(envelope);
for (const socket of clients) sendRawIfOpen(socket, wire);
```
`sendRawIfOpen` at **snapshots.ts:651-653**:
```typescript
function sendRawIfOpen(socket: WebSocket, payload: string): void {
  if (socket.readyState === WS_OPEN) socket.send(payload);
}
```

**`socket.bufferedAmount` accessibility:** The `WebSocket` type from the `ws` library exposes `bufferedAmount` as a standard property. **No `bufferedAmount` guard exists currently.** Adding it is a surgical change to `sendRawIfOpen` or the `for (const socket of clients)` loop in the broadcast function. The correct placement is in `sendRawIfOpen` — check `socket.bufferedAmount` before calling `socket.send(payload)`.

**`buildSnapshot` reads from projection tables vs raw log:** MOSTLY from projection tables (see above). The only raw-log read is `readHubsFromLog` which scans hub registrations — a fixed bounded set (10 rows). All package/trailer/driver state reads from projection tables. **No `O(log-size)` rebuild concern in the ws snapshot path** (only in the audit-timeline catch-up projection, which is already watermarked).

**Where to add `sim-day` counter (CONT-03):** The broadcast closure at snapshots.ts:771-793 receives `simMs` (the authoritative sim-clock milliseconds). Deriving `simDay` is pure arithmetic: `Math.floor((simMs - EPOCH_MS) / MS_PER_DAY)`. The `sim-day` field should be added to the `WsEnvelope` type in `envelope.ts` and populated in the broadcast closure. The ws snapshot on connect can carry `simDay: 0` initially. No DB column needed — it is a pure derivation from `simMs`.

**`diffTick` behavioral note:** It diffs two `SnapshotPayload` objects and returns only changed entities (`TickPayload`). It already handles the zero-change case (empty delta). The `sim-day` field, being on the envelope not the payload, bypasses diffTick — it goes directly on every `WsEnvelope`.

[VERIFIED: snapshots.ts:436-793, queries.ts:194-209]

---

### VQ#8 — Optimizer idempotency map: structure, location, LRU cap

**Data structure** (`packages/api/src/optimizer/rolling-service.ts:87`):
```typescript
private readonly memo = new Map<string, EpochResult>();
```

It is a plain `Map<string, EpochResult>` keyed by `"${epochId}:${scopeHash}"` (rolling-service.ts:126). There is **no size cap, no eviction** — it grows indefinitely.

**Where it is populated** (rolling-service.ts:146-154):
```typescript
this.memo.set(key, fresh);
```
After every non-memoized epoch run (regardless of whether a plan was committed).

**Where it is read** (rolling-service.ts:129-135):
```typescript
const memoized = this.memo.get(key);
if (memoized !== undefined) {
  // ... return cached result without re-running
}
```

**LRU cap placement:** Replace `private readonly memo = new Map<string, EpochResult>()` with an LRU implementation capped at 500 entries. The plan must implement a minimal LRU (JavaScript has none built-in; the `lru-cache` npm package is an option but adds a dependency). Given the project's "no new runtime dependencies for v2.0" constraint, a ~30-LOC custom LRU using `Map` (which has insertion-ordered iteration) is the right choice:

```typescript
// Minimal LRU using Map's insertion order (ES6 spec-guaranteed)
class LruMap<K, V> {
  private readonly cap: number;
  private readonly map = new Map<K, V>();
  constructor(cap: number) { this.cap = cap; }
  get(k: K): V | undefined { /* ... move to end ... */ }
  set(k: K, v: V): void { /* evict LRU if at cap ... */ }
}
```

**No existing LRU utility in the repo** — confirmed by grep for `lru`/`LRU`/`evict` across all non-test, non-dist TS files. The plan must create one (30 LOC inline in rolling-service.ts or a shared util).

[VERIFIED: packages/api/src/optimizer/rolling-service.ts:87-154]

---

### VQ#9 — Golden test infrastructure: location, hash mechanism, fixture path, test command

**Existing golden test** (`packages/simulation/test/determinism.unit.test.ts`):
- Uses `simulate({ seed: 1234, durationTicks: 6000 })` (not seed 42 — the CONTEXT mentions seed 42 but the existing golden uses seed 1234).
- Asserts `JSON.stringify(b) === JSON.stringify(a)` — NOT a hash, just deep equality.
- No committed fixture file — the golden is the output of two back-to-back `simulate()` calls. It proves reproducibility within a run, not cross-architecture stability.

**CORRECTION:** The existing golden test does NOT use a committed hash fixture. It is a same-run reproducibility test. For the **DET-02 10,000-tick cross-architecture hash**, the planner must design a NEW approach:
1. Hash the JSON-serialized stream: `createHash('sha256').update(JSON.stringify(stream)).digest('hex')`.
2. Commit the expected hash as a test constant.
3. If CI runs on both x86 and ARM, both must produce the same hash.

**Template for new 10k golden:** Add a new describe block to `test/determinism.unit.test.ts` (or a new `test/long-run-golden.unit.test.ts`):
```typescript
const LONG_RUN_GOLDEN = "sha256-hash-here"; // committed after first run
it("10k-tick seeded run is byte-identical cross-architecture (DET-02)", () => {
  const stream = simulate({ seed: 42, durationTicks: 10000 });
  const hash = createHash('sha256').update(JSON.stringify(stream)).digest('hex');
  expect(hash).toBe(LONG_RUN_GOLDEN);
});
```

**Note on seed 42 vs seed 1234:** The existing golden uses seed 1234. CONTEXT/REQUIREMENTS use seed 42. Both are valid; seed 42 is the chosen DET-02 target. The new golden uses seed 42 per requirements.

**Test command:** `pnpm vitest run --project unit` or just `pnpm test` (the full gate is `pnpm test:all`).

**Fixture path:** No fixture file needed — hash constant lives in the test file itself. If the hash is committed as a constant, it serves as the golden fixture.

[VERIFIED: packages/simulation/test/determinism.unit.test.ts:1-104]

---

### VQ#10 — `projection_checkpoints` table: existing schema, DDL convention, how to add correctly

**The `projection_checkpoints` table ALREADY EXISTS.** It is defined in:
- **`packages/event-store/src/schema.ts:47-65`** (Kysely interface `ProjectionCheckpointsTable`)
- **`packages/event-store/src/schema.ts:112-115`** (embedded DDL in `SCHEMA_SQL`):
  ```sql
  CREATE TABLE IF NOT EXISTS projection_checkpoints (
    projection TEXT PRIMARY KEY,
    last_seq   BIGINT NOT NULL DEFAULT 0
  );
  ```
- **`packages/event-store/src/schema.sql`** (canonical reviewable DDL, kept byte-identical to embedded string by a unit test)

**The `CatchupDb` interface** in `packages/projections/src/runner/catchup.ts:47-49` already references `projection_checkpoints`:
```typescript
export interface CatchupDb extends ProjectionDatabase {
  projection_checkpoints: CheckpointTable;
}
```

**DDL convention:** All schema changes go in TWO places simultaneously:
1. `packages/event-store/src/schema.ts` SCHEMA_SQL embedded string.
2. `packages/event-store/src/schema.sql` canonical file.
A unit test at `packages/event-store/test/schema-sql.test.ts` asserts they are byte-identical.

**For Phase 19:** NO new table is needed. `projection_checkpoints` is fully implemented and in use by `runCatchup`. The Phase 19 work is purely code-level changes to the driver's inline projection rebuild path (see VQ#6 above).

[VERIFIED: event-store/src/schema.ts:47-50, 76-115; projections/src/runner/catchup.ts:40-87]

---

### VQ#11 — Unbounded lifetime accumulators and unbounded monotonic counters

**Confirmed unbounded lifetime accumulator — `exception_kpi.total_exceptions`:**
`packages/projections/src/reducers/exceptions.ts:133`: `totalExceptions: state.totalExceptions + 1` incremented on every exception event. The `exception_kpi` table has one singleton row that only grows. In a continuous run with RFID enabled, this counter grows without bound. However:
- It is stored in Postgres (not in-memory), so it does not cause process memory growth.
- It is a BIGINT (schema.ts:204), safe to `Number.MAX_SAFE_INTEGER` (2^53), which far exceeds any demo run.
- The value is used only as a rate denominator (`totalExceptions === 0 ? 0 : lowConfidence / total`), so overflow is a theoretical concern only.

**Assessment:** Low risk at demo scale. Note the existence; add an assert if desired (Google consult item #4). No sliding-window conversion needed in Phase 19.

**In-engine monotonic counters** (engine.ts):
- `packageCounter` (line 456): increments once per package. At 1-3 packages per 15-tick batch, a 10,000-tick run creates ~2,000 packages — trivially safe. `P${String(counter).padStart(5, "0")}` works to P99999.
- `tripCounter` (line 457): one per departure. ~N_spokes × (10000 / round_trip_ticks) departures. Also trivially safe.
- `nextSeq` in EventQueue (line 249): one per `schedule()` call. In a 10k-tick run with many events, could reach thousands. Safe well within Number.MAX_SAFE_INTEGER.
- `seq` in ws snapshots (snapshots.ts:693): one per broadcast. Bounded by run duration.

**Driver maps that could grow in HOS mode:**
- `availableAtMinByDriver` (engine.ts:514): entries = all drivers ever registered = fixed at bootstrap. Does not grow with time.
- `clockByDriver` (engine.ts:507): same — fixed at bootstrap.
- `driverByTrailer` (engine.ts:505): fixed at bootstrap.

**Assessment:** No in-memory monotonic counter grows with sim time. All driver maps are fixed-size. Google consult item #4 (audit unbounded counters) yields a clean bill of health for demo-scale runs. The only genuine unbounded accumulation is `exception_kpi.total_exceptions` in Postgres, which is safe.

[VERIFIED: engine.ts:456-458, projections/src/reducers/exceptions.ts:76-133, snapshots.ts:693]

---

### VQ#12 — Paced-loop accumulator: handles infinite tick stream without modification

**Confirmed: the paced-loop accumulator handles an infinite tick stream by design.**

The `driveSimulationPaced` function at driver.ts:496-702 consumes a pre-baked `ticks[]` array (generated once by `simulate()`) and drains it frame by frame:

```typescript
// driver.ts:659 — the frame loop condition
while (nextIndex < ticks.length) {
  // drain frame
}
```

For the **open-ended path**, the approach will be different: instead of pre-generating all ticks into `ticks[]`, the streaming `onEvent` callback path emits events incrementally. The paced-loop's `simClock` accumulator math (`computeSimAdvanceMs` + `selectDrain`) in `pacing.ts` is pure and handles any tick stream — it advances the clock by wall-delta × rate and drains whatever is available. It does NOT need modification for an open-ended stream.

**However:** The current architecture pre-bakes the ENTIRE stream into memory before draining. For a `runUntilStopped` run, this is incompatible — you cannot pre-bake an infinite stream. The plan must add a new driver function (e.g., `driveSimulationOpenEnded`) that:
1. Does NOT call `simulate()` upfront.
2. Drives the engine incrementally — calling `generate()` chunk by chunk, or using the streaming `onEvent` callback to feed events into a bounded in-memory buffer.
3. Uses the same pacing math from `pacing.ts` (unchanged).

**The CONTEXT statement "the paced-loop accumulator already handles an infinite tick stream without modification" is PARTIALLY WRONG.** The math handles it; the driver architecture that pre-bakes all ticks does not. The plan must design the open-ended driver differently from `driveSimulationPaced`.

[VERIFIED: driver.ts:496-702, pacing.ts:1-106]

---

## Standard Stack

No new runtime dependencies for Phase 19. All changes are in existing packages.

| Package | Version | Role in Phase 19 |
|---------|---------|-----------------|
| `@mm/simulation` | internal | Engine stop-signal + streaming emit |
| `@mm/api` | internal | Driver open-ended path + ws backpressure + LRU optimizer |
| `@mm/projections` | internal | No change needed (catchup already watermarked) |
| `ws` | 8.21.x | `WebSocket.bufferedAmount` property for backpressure guard |
| `vitest` | 4.1.x | New 10k-tick golden test |
| `node:crypto` | built-in | `createHash('sha256')` for golden hash |

---

## Architecture Patterns

### System Architecture Diagram

```
[Virtual Clock (deterministic)]
        |
        v
[EventQueue — (fireTick, seq) sorted array]
        |
  [generate() loop]
        |-- durationTicks ceiling (EXISTING, PRESERVED)
        |-- runUntilStopped flag (NEW)
        |-- onEvent callback (NEW streaming path)
        |-- out[] array accumulation (EXISTING, for simulate())
        |
        v
[simulate() / runSimulation()]  ← golden tests use simulate()
        |
        v
[driveSimulationOpenEnded()]  ← NEW function for live run
  |-- appendTick() per tick
  |-- foldFrame() once per frame (reuse from driveSimulationPaced)
  |-- coalescer.trigger() for optimizer (reuse)
  |-- broadcast(simMs) per frame (+ sim-day counter)
        |
        v
[WS broadcast → sendRawIfOpen]
  |-- bufferedAmount guard (NEW, ~5 LOC)
  |-- simDay field on WsEnvelope (NEW)
        |
        v
[RollingOptimizerService.memo (LRU cap)]
  |-- LruMap<string, EpochResult> (NEW, ~30 LOC)
```

### Recommended Project Structure

No new files required for the core changes. New file needed:
```
packages/api/src/optimizer/lru-map.ts  # ~30 LOC LRU utility
```

Or inline the LRU into `rolling-service.ts` if preferred.

### Pattern 1: Open-Ended Loop Stop Signal

```typescript
// packages/simulation/src/engine.ts — generate() main loop (MODIFIED)
// Source: engine.ts:1227-1234 (existing), modified for runUntilStopped
const stopped = { value: false };
for (;;) {
  const action = queue.pop();
  if (action === undefined) break;
  if (!opts.runUntilStopped && action.fireTick > durationTicks) break; // PRESERVED
  if (opts.runUntilStopped && stopped.value) break;                    // NEW
  clock.advance(action.fireTick - currentTick(clock));
  action.run();
}
```

The `stopped` object is mutated by an external `stop()` handle or an injected `shouldStop(tick)` predicate. Choice is Claude's discretion.

### Pattern 2: Self-Rescheduling Removal (CONT-02)

Two guards in engine.ts must be conditioned on `!runUntilStopped`:

```typescript
// engine.ts:722-723 (createPackageBatch)
const nextTick = tick + PACKAGE_INTERVAL_TICKS;
if (!opts.runUntilStopped || nextTick <= durationTicks) { // MODIFIED
  schedule(nextTick, () => createPackageBatch(nextTick));
}

// engine.ts:1165-1168 (arriveTrailer)
if (!opts.runUntilStopped || nextDepart <= durationTicks) { // MODIFIED
  schedule(nextDepart, () => departTrailer(trailerId, spoke, nextDepart));
}
```

### Pattern 3: WS Backpressure Guard

```typescript
// packages/api/src/ws/snapshots.ts — sendRawIfOpen (MODIFIED)
const BACKPRESSURE_BYTES = 256 * 1024; // 256 KB

function sendRawIfOpen(socket: WebSocket, payload: string): void {
  if (socket.readyState !== WS_OPEN) return;
  if (socket.bufferedAmount > BACKPRESSURE_BYTES) return; // NEW — skip tick for saturated client
  socket.send(payload);
}
```

### Pattern 4: Optimizer LRU (~30 LOC)

```typescript
// packages/api/src/optimizer/lru-map.ts (NEW FILE)
export class LruMap<K, V> {
  private readonly cap: number;
  private readonly map = new Map<K, V>(); // insertion order = LRU order
  constructor(cap: number) { this.cap = cap; }
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) { this.map.delete(k); this.map.set(k, v); } // move to end (MRU)
    return v;
  }
  set(k: K, v: V): void {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.cap) {
      this.map.delete(this.map.keys().next().value); // evict LRU (oldest = first)
    }
  }
}
// Replace `private readonly memo = new Map<...>()` in rolling-service.ts with:
// private readonly memo = new LruMap<string, EpochResult>(500);
```

### Pattern 5: Sim-Day Counter in WS Envelope

```typescript
// envelope.ts — add simDay to WsEnvelope (or TickPayload)
// snapshots.ts broadcast closure — derive simDay
const EPOCH_MS = Date.parse("2026-04-01T00:00:00.000Z"); // matches engine EPOCH_ISO
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// in broadcast(simMs):
const simDay = Math.floor((simMs - EPOCH_MS) / MS_PER_DAY);
// Add simDay to the WsEnvelope so the client renders it
```

### Anti-Patterns to Avoid

- **Do not call `simulate()` upfront for the open-ended path.** Pre-baking an infinite stream into `ticks[]` would require unbounded memory.
- **Do not use `setInterval` for the frame loop.** The existing paced loop uses chained `setTimeout` via `sleep()` — maintain this pattern.
- **Do not add `simDay` to the `SnapshotPayload` (the diff-able part).** Put it on the outer `WsEnvelope` so it is sent every tick without diff overhead.
- **Do not use `socket.bufferedAmount` as the skip criterion for the initial snapshot.** Only skip tick deltas, never the initial snapshot (the client would never initialize).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| LRU eviction | Complex doubly-linked list + Map | ~30 LOC `LruMap` using ES6 Map insertion order | Map's insertion order is spec-guaranteed; simple enough to own without a dep |
| SHA-256 hash for golden | Custom hash | `node:crypto` `createHash('sha256')` | Built-in; already used in freeze-idempotency.ts |
| Pacing math | New frame scheduler | Reuse `computeSimAdvanceMs` + `selectDrain` from pacing.ts | Already correct and tested |
| WS frame buffering | Per-client queue | `socket.bufferedAmount` guard | The ws library manages its own buffer; just skip when full |

---

## Common Pitfalls

### Pitfall 1: Pre-baking the stream for open-ended mode
**What goes wrong:** Calling `simulate({ durationTicks: Infinity })` or equivalent to generate the "full" open-ended stream — produces infinite loop and OOM.
**How to avoid:** The open-ended driver must be structured as an incremental loop that generates and drains events chunk by chunk (or event by event via the `onEvent` callback), never pre-baking beyond a buffer size.
**Warning signs:** `ticks = intoTicks(stream)` call on an open-ended stream.

### Pitfall 2: Breaking golden tests by changing the finite path
**What goes wrong:** Modifying the `if (nextTick <= durationTicks)` guards unconditionally rather than conditioning on `runUntilStopped`.
**How to avoid:** All guards MUST remain active when `runUntilStopped` is false. Run `pnpm test` with `determinism.unit.test.ts` after every engine change.
**Warning signs:** Existing golden test at `test/determinism.unit.test.ts` produces a different event count or different JSON.

### Pitfall 3: Float drift in 10k-tick golden
**What goes wrong:** `sampleLogNormal` uses `Math.exp`/`Math.log` which are implementation-defined. On ARM the result may differ from x86 by 1 ULP after thousands of iterations.
**How to avoid:** Generate the 10k golden on the CI architecture first. If the hash differs between local (x86) and CI (ARM), switch to the integer lookup table approach for transit/dwell draws.
**Warning signs:** Golden hash passes locally but fails on CI runner.

### Pitfall 4: `bufferedAmount` guard skipping the wrong messages
**What goes wrong:** Applying the backpressure guard to the initial snapshot — the client never initializes. Or applying it to EVERY message including the resync response — the client can never recover.
**How to avoid:** Only apply the guard in the `broadcast` function's per-client send loop (tick deltas). Never in the initial snapshot send or the resync response handler.
**Warning signs:** New clients connect and see a blank map; tabs that reconnect after backgrounding stay blank.

### Pitfall 5: sim-day calculation using wall clock
**What goes wrong:** Deriving `simDay` from `Date.now()` instead of `simMs` — the sim-day counter would advance with wall clock time during a paused run.
**How to avoid:** Always `simDay = Math.floor((simMs - EPOCH_MS) / MS_PER_DAY)`. The `EPOCH_MS` is `Date.parse("2026-04-01T00:00:00.000Z")` — must match `EPOCH_ISO` in engine.ts.

### Pitfall 6: LRU eviction disrupting idempotency for very recent epochs
**What goes wrong:** The LRU cap at 500 is too small if the optimizer runs very frequently over a large hub network, causing recently-seen `(epochId, scopeHash)` entries to evict before the same epoch arrives again, triggering re-runs.
**How to avoid:** 500 is 2× the number of active trailers at max fleet configuration. Verify this is sufficient. The `epochId` is derived from `simMs` (changing every tick), so re-submitted epochs with the SAME epochId are rare — eviction mostly affects stale old epochs.

---

## Runtime State Inventory

Phase 19 is not a rename/refactor/migration phase. No runtime state inventory required.

---

## Environment Availability

Phase 19 is purely code changes to existing packages. No new external dependencies. The existing Postgres and Node.js environment is assumed to be in place from prior phases.

| Dependency | Required By | Available | Notes |
|------------|------------|-----------|-------|
| Postgres (existing) | `projection_checkpoints` (already in schema) | ✓ | No change |
| Node.js 22 LTS | Engine, API | ✓ | No change |
| `node:crypto` | 10k-tick hash golden | ✓ | Built-in |
| `ws` 8.21.x | `bufferedAmount` guard | ✓ | `WebSocket.bufferedAmount` is a standard ws property |

---

## Validation Architecture

The following test map covers all Phase 19 requirements. Run commands use `vitest run --project unit` for unit tests and `vitest run --project integration` for integration tests.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.x |
| Config file | `vitest.config.ts` at repo root |
| Quick run command | `pnpm test` (turbo build + unit) |
| Full suite command | `pnpm test:all` (unit + integration + ui) |
| Type gate | `pnpm typecheck` (separate, catches test-file TS errors) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File |
|--------|----------|-----------|-------------------|------|
| CONT-01 | `runUntilStopped` loop runs past `durationTicks` ceiling | unit | `vitest run -t "open-ended loop"` | `packages/simulation/test/open-ended.unit.test.ts` (new) |
| CONT-01 | Finite path unchanged (golden byte-identical) | unit | `vitest run packages/simulation/test/determinism.unit.test.ts` | existing |
| CONT-02 | `createPackageBatch` re-schedules past original durationTicks in open-ended mode | unit | `vitest run -t "self-rescheduling"` | `open-ended.unit.test.ts` (new) |
| CONT-02 | `arriveTrailer` schedules next departure past durationTicks in open-ended mode | unit | same file | same |
| CONT-03 | `simDay` field present on `WsEnvelope` tick messages | unit | `vitest run -t "simDay"` | `packages/api/test/ws-envelope.unit.test.ts` (extend existing or new) |
| CONT-03 | `simDay` derived from `simMs` (not wall clock) | unit | same | same |
| CONT-04a | `runCatchup` reads from checkpoint, not from 0n (watermark) | integration | `vitest run packages/projections/test/catchup.int.test.ts` | existing |
| CONT-04b | WS `sendRawIfOpen` skips when `bufferedAmount > 256KB` | unit | `vitest run -t "backpressure"` | `packages/api/test/snapshots.unit.test.ts` (new or extend) |
| CONT-04b | Initial snapshot and resync response bypass backpressure guard | unit | same | same |
| CONT-04c | `LruMap` evicts oldest entry when cap exceeded | unit | `vitest run -t "LruMap"` | `packages/api/test/lru-map.unit.test.ts` (new) |
| CONT-04c | `RollingOptimizerService.memo` stays bounded at 500 entries | unit | same | `packages/api/test/rolling-service.unit.test.ts` (extend) |
| DET-01 | `runUntilStopped: false` + all v2.0 flags absent → byte-identical seed-42 golden | unit | `vitest run packages/simulation/test/determinism.unit.test.ts` | existing (add one case) |
| DET-02 | `simulate({ seed: 42, durationTicks: 10000 })` produces committed hash | unit | `vitest run packages/simulation/test/determinism.unit.test.ts` | new describe block |
| — | `EventQueue` same-tick tie-break is deterministic (VQ#2 verification) | unit | `vitest run -t "tie-break"` | `open-ended.unit.test.ts` or separate |
| — | `buildRoutes()` emits BOTH directions for each spoke (VQ#5 verification) | unit | `vitest run packages/simulation/src/network.test.ts` | existing (add assertion) |
| — | 5 existing salts remain pairwise-distinct (regression) | unit | `vitest run packages/simulation/test/fuel-determinism.unit.test.ts` | existing |

### Sampling Rate

- **Per task commit:** `pnpm test` (turbo build + vitest unit — the task-level gate)
- **Per wave merge:** `pnpm test:all` (full suite: unit + integration + ui)
- **Phase gate:** `pnpm build && pnpm typecheck && pnpm lint && pnpm test:all` all green before `/gsd-verify-work`

### Wave 0 Gaps (Test Files to Create)

- [ ] `packages/simulation/test/open-ended.unit.test.ts` — covers CONT-01, CONT-02
- [ ] `packages/api/test/lru-map.unit.test.ts` — covers CONT-04c LRU unit
- [ ] New describe block in `packages/simulation/test/determinism.unit.test.ts` — covers DET-02 (10k hash)
- [ ] Extend `packages/api/test/snapshots.unit.test.ts` or create new — covers CONT-04b backpressure

*(Existing `fuel-determinism.unit.test.ts`, `catchup.int.test.ts`, `determinism.unit.test.ts`, `network.test.ts` cover the regression and verification tests without modification)*

---

## Security Domain

Phase 19 makes no changes to authentication, session management, input validation, or cryptography. The `createHash('sha256')` use is for test fixture hashing, not for any user-facing security purpose. No ASVS categories are implicated.

---

## Open Questions (RESOLVED)

> All three resolved during plan-phase by design decisions in the plans. Resolution noted per item.

1. **10k-tick golden hash — cross-architecture verification** — **RESOLVED (plan 19-03).**
   - What we know: Existing golden uses JSON equality (same run), not a committed hash.
   - What's unclear: Whether CI runs on ARM as well as x86 (the cross-arch assertion in DET-02).
   - Recommendation: Generate the hash on CI, commit it. If CI is single-arch, document as single-arch verified and add a note to run locally on both architectures. Do NOT block phase close on cross-arch — ship the hash from CI and document the mitigation.
   - **Resolution:** Plan 19-03 commits the real hash from the run and documents the single-arch CI mitigation + integer-lookup-table contingency in its acceptance criteria.

2. **Open-ended driver architecture — streaming buffer size** — **RESOLVED (plan 19-04).**
   - What we know: `driveSimulationPaced` pre-bakes all ticks; incompatible with open-ended.
   - What's unclear: The ideal buffer size for the streaming approach (emit N ticks ahead, drain as consumed).
   - Recommendation: A simple approach: run `generate()` incrementally by chunking — call simulate with `durationTicks = currentTick + CHUNK_SIZE`, extend the horizon each time. This reuses all existing infrastructure. The CONTEXT describes `onEvent` callback as the mechanism; design the driver to buffer at most one chunk in memory at a time.
   - **Resolution:** Plan 19-04 adopts the chunked approach (CHUNK_SIZE = 500 ticks); `driveSimulationOpenEnded()` does NOT call `simulate()` upfront (no pre-baking of an infinite stream).

3. **`sim-day` field placement on `WsEnvelope` vs `TickPayload`** — **RESOLVED (plan 19-05).**
   - What we know: `simMs` is already on every `WsEnvelope`. `simDay` can be derived client-side.
   - What's unclear: Whether the UI team (this is solo/agentic) wants server-derived `simDay` or is OK computing it from `simMs`.
   - Recommendation: Add `simDay` to `WsEnvelope` (alongside `simMs`) for simplicity. The client then just reads `envelope.simDay`. Avoids client-side epoch math.
   - **Resolution:** Plan 19-05 adds `simDay` to `WsEnvelope` (both union variants, envelope-level — bypasses `diffTick`), derived from `simMs` (never wall-clock).

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The `ws` library's `WebSocket` type exposes `bufferedAmount` on the server side | VQ#7 | `bufferedAmount` may only exist on the browser WebSocket API; need to verify `ws` package server-side type. Low risk — `ws` 8.x does expose it. [ASSUMED from training] |
| A2 | CI runs Vitest on a single architecture (not both x86 and ARM) | VQ#9 | If CI IS dual-arch, the hash may diverge and require the integer lookup table mitigation before phase close | [ASSUMED] |
| A3 | `Map` insertion order in V8/Node 22 matches spec (ECMA 2015+) | VQ#8 LRU | If non-compliant, LRU eviction order would be wrong. Risk is extremely low — Node 22 complies fully. [ASSUMED from training — HIGH confidence] |

**All other claims in this research were VERIFIED against source files in this session.**

---

## Sources

### Primary (HIGH confidence — direct codebase reads in this session)

- `packages/simulation/src/engine.ts` (1,267 LOC) — EventQueue (lines 247-275), generate() stop condition (1231), self-rescheduling guards (723, 1166-1168), salt constants (71-93), out-array accumulation (382, 460-462), simulate()/runSimulation() wrappers (1251-1266)
- `packages/simulation/src/rng.ts` — mulberry32 + splitmix32 + makeRng() (complete file)
- `packages/simulation/src/network/routes.ts` — buildRoutes() (283-306), applyRoadGeometry(), geometry shape
- `packages/simulation/test/determinism.unit.test.ts` — existing golden test pattern (complete file)
- `packages/simulation/test/fuel-determinism.unit.test.ts` — salt-collision assertion (43-56)
- `packages/simulation/test/hos-determinism.unit.test.ts` — earlier salt-collision assertion (32-43)
- `packages/api/src/sim/driver.ts` — driveSimulationPaced() (496-702), foldFrame() (573-602), cursor initialization (349, 524), readAll usage (385, 403, 575, 590)
- `packages/api/src/sim/pacing.ts` — computeSimAdvanceMs(), selectDrain() (complete file)
- `packages/api/src/ws/snapshots.ts` — buildSnapshotPayload() (436-642), broadcast closure (771-793), sendRawIfOpen() (651-653)
- `packages/api/src/optimizer/rolling-service.ts` — memo Map (87), runOnce() idempotency path (120-155)
- `packages/optimizer/src/rolling/freeze-idempotency.ts` — scopeHash(), isFrozen() (complete file)
- `packages/projections/src/runner/catchup.ts` — runCatchup() (295-302), readCheckpoint() (62-71), advanceCheckpoint() (74-87), runAuditTimeline() (155-168), runGeoTrack() (248-282)
- `packages/event-store/src/schema.ts` — projection_checkpoints table DDL (47-50, 112-115), global_seq type (19, 98)
- `packages/projections/src/schema.ts` — exception_kpi unbounded accumulator (198-204)
- `packages/api/src/routes/queries.ts` — readHubsFromLog() raw-log scan (194-209)

### Secondary (MEDIUM confidence)

- CONTEXT.md, REQUIREMENTS.md, ROADMAP.md, SUMMARY.md, PITFALLS.md — design decisions and architectural intent
- Root `package.json` — gate commands: `pnpm test`, `pnpm test:all`, `pnpm typecheck`, `pnpm check`

---

## Metadata

**Confidence breakdown:**
- Engine stop condition / EventQueue tie-break: HIGH — read exact source
- Streaming emit / onEvent hook-in: HIGH — read exact source
- buildRoutes() bidirectionality: HIGH — already emits both directions (CONTEXT assumption was WRONG in the sense it implied this was future work)
- projection_checkpoints: HIGH — fully implemented (CONTEXT was right it exists; CONTEXT was imprecise about driver.ts `readAll(db, 0n)`)
- WS backpressure gap: HIGH — confirmed no `bufferedAmount` guard exists
- Optimizer LRU gap: HIGH — confirmed memo is plain unbounded Map
- Paced-loop compatibility: HIGH — confirmed pre-baking architecture requires a new open-ended driver function

**Key corrections to CONTEXT.md:**
1. `buildRoutes()` already emits BOTH directions. "Bidirectional route registration" is verification-only in Phase 19.
2. `projection_checkpoints` table already exists and `runCatchup` already uses watermarks. The inline projection cursor (`let cursor = 0n`) is a separate, per-run session cursor — also a valid improvement but not the "full-from-0 rebuild" described.
3. The paced-loop accumulator does NOT handle an infinite tick stream without modification — it pre-bakes all ticks into memory. A new open-ended driver function is needed.
4. The existing determinism golden uses seed 1234, not seed 42. The DET-02 requirement specifies seed 42, which means a NEW golden hash test (not modification of the existing one).

**Research date:** 2026-06-24
**Valid until:** 2026-07-24 (stable codebase; 30-day window)
