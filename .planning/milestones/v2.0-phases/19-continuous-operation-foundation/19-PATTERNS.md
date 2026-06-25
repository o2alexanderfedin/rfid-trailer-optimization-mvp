# Phase 19: Continuous Operation Foundation - Pattern Map

**Mapped:** 2026-06-24
**Files analyzed:** 10 (7 modified + 3 new)
**Analogs found:** 10 / 10

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/simulation/src/engine.ts` | engine/generator | event-driven, streaming | self (existing generate loop) | exact-self |
| `packages/simulation/src/network/routes.ts` | utility | transform | self (already bidirectional) | exact-self (verify only) |
| `packages/api/src/sim/driver.ts` | service | streaming, event-driven | self (driveSimulationPaced) | exact-self |
| `packages/api/src/sim/pacing.ts` | utility | transform | self (unchanged) | exact-self (no change) |
| `packages/api/src/ws/snapshots.ts` | service | request-response, streaming | self (sendRawIfOpen/broadcast) | exact-self |
| `packages/api/src/ws/envelope.ts` | type/utility | transform | self (WsEnvelope union) | exact-self |
| `packages/api/src/optimizer/rolling-service.ts` | service | CRUD | self (memo Map) | exact-self |
| `packages/api/src/optimizer/lru-map.ts` | utility | CRUD | none (new) | no analog |
| `packages/simulation/test/open-ended.unit.test.ts` | test | event-driven | `determinism.unit.test.ts` | exact-role |
| `packages/api/test/lru-map.unit.test.ts` | test | CRUD | `ws-rejection.test.ts` (pure-unit pattern) | role-match |

---

## Pattern Assignments

### `packages/simulation/src/engine.ts` (engine, event-driven)

**Analog:** self — existing `generate()` loop

**Current stop-condition pattern** (`engine.ts:1227-1234`):
```typescript
for (;;) {
  const action = queue.pop();
  if (action === undefined) break;           // queue empty
  if (action.fireTick > durationTicks) break; // TIME CEILING — line 1231 (SURGICAL TARGET)
  clock.advance(action.fireTick - currentTick(clock));
  action.run();
}
```

**Self-rescheduling guards** (`engine.ts:722-723` and `engine.ts:1165-1168`):
```typescript
// createPackageBatch — line ~723
if (nextTick <= durationTicks) schedule(nextTick, () => createPackageBatch(nextTick));

// arriveTrailer — line ~1166
if (nextDepart <= durationTicks) { schedule(nextDepart, () => departTrailer(trailerId, spoke, nextDepart)); }
```
Both guards must stay active for finite path; be conditioned on `!runUntilStopped` for the open-ended path.

**Out-array accumulation** (`engine.ts:382, 460-462`):
```typescript
const out: SimulatedEvent[] = [];          // line 382

const emit = (streamId: string, event: DomainEvent): void => {
  out.push({ streamId, event, occurredAt: clock.nowIso() });  // lines 460-462
};
```
For streaming open-ended path: add `opts.onEvent?.(item) ?? out.push(item)` branch at the `out.push` call.

**Public wrapper pattern** (`engine.ts:1251-1266`):
```typescript
export function simulate(opts: SimulateOptions): SimulatedEvent[] {
  return generate(opts);                     // line 1252 — golden-test surface, unchanged
}

export async function runSimulation(opts: RunSimulationOptions): Promise<void> {
  const stream = generate(opts);             // line 1262
  for (const item of stream) {
    await opts.sink(item);                   // line 1264
  }
}
```
New `driveSimulationOpenEnded()` in driver.ts parallels `simulate()` — does NOT call `generate()` upfront.

**EventQueue tie-break pattern** (`engine.ts:247-275`):
```typescript
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

function schedule(fireTick: number, run: () => void): void {
  queue.push(fireTick, queue.claimSeq(), run);  // line 1214 — insertion-order seq is the tie-break
}
```
Already deterministic. Planner only needs a verification test.

**Salt constants pattern** (`engine.ts:71-93`):
```typescript
const RFID_RNG_SALT       = 0x5f_1d_a7_c3;  // line 71
const OVER_CARRY_RNG_SALT = 0x3c_a7_1d_5f;  // line 73
const TIMING_RNG_SALT     = 0x00_00_77_17;  // line 75
const HOS_RNG_SALT        = 0x10_51_09_01;  // line 82
const FUEL_RNG_SALT       = 0x2b_3d_91_e7;  // line 93
```
Any new salt (Phase 20+) must be exported and added to the pairwise-distinct assertion in `fuel-determinism.unit.test.ts`.

---

### `packages/api/src/sim/driver.ts` — new `driveSimulationOpenEnded()` (service, streaming)

**Analog:** existing `driveSimulationPaced()` (lines 496-702) — same file

**Pre-baking pattern to NOT replicate** (lines 499-510):
```typescript
// driveSimulationPaced — lines 499-510 — DO NOT COPY this for open-ended
const stream = simulate({
  seed: opts.seed,
  durationTicks: opts.durationTicks,
  ...
});
const ticks = intoTicks(stream);
const tickTimesMs = ticks.map((tick) => new Date(tick[0]!.occurredAt).getTime());
```
For open-ended: never pre-bake. Use chunked `generate()` calls or `onEvent` callback.

**`appendTick` pattern to reuse** (lines 533-562):
```typescript
async function appendTick(tick: SimulatedEvent[]): Promise<void> {
  const perStream = new Map<string, SimulatedEvent[]>();
  for (const item of tick) {
    const buf = perStream.get(item.streamId) ?? [];
    buf.push(item);
    perStream.set(item.streamId, buf);
  }
  for (const [streamId, items] of perStream) {
    const current = await es
      .selectFrom("streams")
      .select("version")
      .where("stream_id", "=", streamId)
      .executeTakeFirst();
    await appendToStream(
      es,
      streamId,
      current?.version ?? 0,
      items.map((i) => i.event),
      new Date(items[0]!.occurredAt),
    );
  }
}
```

**`foldFrame` pattern to reuse** (lines 573-602):
```typescript
async function foldFrame(): Promise<void> {
  const fresh = await readAll(es, cursor);
  if (fresh.length > 0) {
    await opts.db.transaction().execute(async (trx) => {
      const proj = projectionView(trx as unknown as Kysely<ProjectionDb>);
      for (const ev of fresh) await applyInline(proj, ev);
    });
    cursor = fresh[fresh.length - 1]!.globalSeq;
  }
  // ... detection pass ...
  await runCatchup(catchupView(opts.db), replayReadAll);
}
```

**Frame loop pattern to adapt** (lines 659-702):
```typescript
while (nextIndex < ticks.length) {         // for open-ended: while (!stopped.value)
  await sleep(frameMs);
  const now = performance.now();
  const wallDeltaMs = now - lastWall;
  lastWall = now;

  const paused = opts.isPaused?.() === true;
  const multiplier = paused ? 0 : (opts.getMultiplier?.() ?? 1);

  simClock += computeSimAdvanceMs({
    wallDeltaMs,
    multiplier,
    msPerTick: MS_PER_TICK,
    defaultIntervalMs: DEFAULT_INTERVAL_MS,
  });
  // ...
  if (opts.broadcast !== undefined) {
    await opts.broadcast(broadcastSimMs);
  }
}
```
For open-ended: loop condition becomes `while (!stopped.value)` and tick generation is incremental rather than pre-baked.

---

### `packages/api/src/sim/pacing.ts` (utility, transform)

**No changes needed.** Read-only reference only.

**`computeSimAdvanceMs` signature** (lines 43-54):
```typescript
export function computeSimAdvanceMs(args: ComputeSimAdvanceArgs): number
// args: { wallDeltaMs, multiplier, msPerTick, defaultIntervalMs, maxWallDeltaMs? }
// returns: sim-ms to advance this frame (pure, no I/O)
```

**`selectDrain` signature** (lines 89-106):
```typescript
export function selectDrain(args: SelectDrainArgs): SelectDrainResult
// args: { tickTimesMs, nextIndex, simClock, maxTicks }
// returns: { count, clampSimClock }
// NOTE: for open-ended, tickTimesMs changes each chunk — use per-chunk slice
```

---

### `packages/api/src/ws/snapshots.ts` (service, streaming)

**Analog:** self — existing `sendRawIfOpen` and `broadcast` closure

**Current `sendRawIfOpen` pattern** (lines 651-653) — **SURGICAL TARGET**:
```typescript
function sendRawIfOpen(socket: WebSocket, payload: string): void {
  if (socket.readyState === WS_OPEN) socket.send(payload);
}
```
Add `bufferedAmount` guard here — NOT in the broadcast loop or initial snapshot send:
```typescript
const BACKPRESSURE_BYTES = 256 * 1024;

function sendRawIfOpen(socket: WebSocket, payload: string): void {
  if (socket.readyState !== WS_OPEN) return;
  if (socket.bufferedAmount > BACKPRESSURE_BYTES) return;  // NEW guard
  socket.send(payload);
}
```

**Broadcast closure** (lines 771-793):
```typescript
return async (simMs: number): Promise<WsEnvelope> => {
  const current = await build(db);
  const prev = baseline ?? emptySnapshotPayload();
  baseline = current;

  speedController.noteSimMs(simMs);

  const delta: TickPayload = diffTick(prev, current);
  seq += 1;
  const envelope: WsEnvelope = {
    v: 1,
    type: "tick",
    seq,
    simMs,
    speed: currentSpeed(),
    payload: delta,
  };
  const wire = JSON.stringify(envelope);
  for (const socket of clients) sendRawIfOpen(socket, wire);  // backpressure guard here
  return envelope;
};
```
`simDay` is derived here: `const simDay = Math.floor((simMs - EPOCH_MS) / MS_PER_DAY)` and added to `envelope`.

**Initial snapshot send** (lines 750-767) — backpressure guard must NOT apply here:
```typescript
fetchAndUpdateBaseline()
  .then((payload) => {
    seq += 1;
    const envelope: WsEnvelope = { v: 1, type: "snapshot", seq, simMs: 0, speed: currentSpeed(), payload };
    sendRawIfOpen(socket, JSON.stringify(envelope));  // initial: bufferedAmount is 0 — guard harmless but note intent
  })
```
Comment that the guard is safe here (bufferedAmount is 0 on fresh connect), but the intent is to skip stale *tick* deltas.

---

### `packages/api/src/ws/envelope.ts` (type/utility, transform)

**Analog:** self — existing `WsEnvelope` union type

**Current `WsEnvelope` union** (lines 218-220):
```typescript
export type WsEnvelope =
  | { readonly v: 1; readonly type: "snapshot"; readonly seq: number; readonly simMs: number; readonly speed: SimSpeedState; readonly payload: SnapshotPayload }
  | { readonly v: 1; readonly type: "tick";     readonly seq: number; readonly simMs: number; readonly speed: SimSpeedState; readonly payload: TickPayload };
```
Add `readonly simDay: number` as an envelope-level field on BOTH variants, beside `simMs`. Never inside `SnapshotPayload` or `TickPayload` (bypasses `diffTick`).

**How `speed` field was added** as a prior extension reference — it appears at the envelope level, mirrored in both union variants. Follow the exact same pattern for `simDay`.

**`SimSpeedState` envelope-level field precedent** (lines 35-40):
```typescript
export interface SimSpeedState {
  readonly multiplier: number;
  readonly tickIntervalMs: number;
  readonly simSpeed: number;
  readonly paused: boolean;
}
```
`simDay: number` is simpler (a single integer derived from `simMs`). No interface needed — add directly to both union members.

---

### `packages/api/src/optimizer/rolling-service.ts` (service, CRUD)

**Analog:** self — `this.memo` Map field

**Current unbounded `memo` field** (line 87):
```typescript
private readonly memo = new Map<string, EpochResult>();
```

**Idempotency key construction** (line 126):
```typescript
const key = `${epoch.epochId}:${fresh.scopeHash}`;
```

**Memo get pattern** (lines 129-135):
```typescript
const memoized = this.memo.get(key);
if (memoized !== undefined) {
  this.latest = memoized;
  if (memoized.recommendations.length > 0) {
    this.latestNonEmpty = memoized;
  }
  return { result: memoized, committed: false };
}
```

**Memo set pattern** (line 146):
```typescript
this.memo.set(key, fresh);
```

Replace `new Map<string, EpochResult>()` with `new LruMap<string, EpochResult>(500)`.
The `get(key)` and `set(key, value)` call signatures are identical — drop-in replacement.

---

### `packages/api/src/optimizer/lru-map.ts` (utility, CRUD) — **NEW FILE, NO ANALOG**

No existing LRU utility in the codebase (confirmed by grep for `lru`/`LRU`/`evict` in non-test, non-dist TS). Build from the ES6 Map insertion-order guarantee.

**Pattern from RESEARCH.md** (Pattern 4 — confirmed correct by VQ#8):
```typescript
export class LruMap<K, V> {
  private readonly cap: number;
  private readonly map = new Map<K, V>(); // insertion order = LRU order (ES6 spec-guaranteed)
  constructor(cap: number) { this.cap = cap; }
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v); // move to end (MRU position)
    }
    return v;
  }
  set(k: K, v: V): void {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.cap) {
      // Evict LRU entry: first key in insertion order
      this.map.delete(this.map.keys().next().value as K);
    }
  }
  get size(): number { return this.map.size; }
}
```
~30 LOC. Place in `packages/api/src/optimizer/lru-map.ts`.

---

### `packages/simulation/test/open-ended.unit.test.ts` — **NEW FILE**

**Analog:** `packages/simulation/test/determinism.unit.test.ts` (exact role match)

**Test file structure to copy** (`determinism.unit.test.ts:1-104`):
```typescript
import { describe, expect, it } from "vitest";
import { validateEvent } from "@mm/domain";
import { simulate } from "../src/engine.js";

/**
 * [descriptive JSDoc block — what requirement this covers, what is being tested]
 */

const OPTS = { seed: 1234, durationTicks: 6000 } as const;

describe("[test suite name (requirement id)]", () => {
  it("[behavior under test]", () => {
    // ...
  });
  // ...
});
```

Key conventions from this file:
- `import { describe, expect, it } from "vitest"` — no `vi`, `beforeEach`, `afterEach` unless needed
- Named `OPTS` constant for shared sim options
- `simulate(OPTS)` not `simulate({ ...OPTS })` for the single-run case
- `JSON.stringify(b) === JSON.stringify(a)` for byte-identity assertion
- `expect(b).toEqual(a)` for deep equality first, then JSON stringify for byte-identity
- `expect(count).toBeGreaterThan(0)` not `expect(count).toBeGreaterThanOrEqual(1)`

**File naming convention:** `*.unit.test.ts` → goes into `unit` vitest project (no int, no tsx).
Route: `packages/simulation/test/open-ended.unit.test.ts`.

**CONT-01/02 test shape to create:**
```typescript
import { describe, expect, it } from "vitest";
import { simulate } from "../src/engine.js";

/**
 * CONT-01/02 — Open-ended loop control-flow.
 * ...
 */

describe("open-ended loop (CONT-01)", () => {
  it("runUntilStopped: false with durationTicks — same stream as simulate() (DET-01 regression)", () => { ... });
  it("stop() handle terminates the loop after the signal", () => { ... });
});

describe("self-rescheduling past durationTicks (CONT-02)", () => {
  it("createPackageBatch re-schedules beyond original durationTicks in open-ended mode", () => { ... });
  it("arriveTrailer schedules next departure past durationTicks in open-ended mode", () => { ... });
});

describe("EventQueue same-tick tie-break determinism (VQ#2 verification)", () => {
  it("two events at the same fireTick fire in insertion order and produce byte-identical streams", () => { ... });
});
```

---

### `packages/simulation/test/determinism.unit.test.ts` — add new describe block (DET-02)

**Analog:** self — existing describe blocks in same file

**Existing golden pattern** (lines 22-28):
```typescript
describe("deterministic event stream (SIM-02)", () => {
  it("same seed -> byte-identical stream (deep-equal incl. order + occurredAt)", () => {
    const a = simulate(OPTS);
    const b = simulate({ ...OPTS });
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
```

**New DET-02 10k hash describe block to add:**
```typescript
import { createHash } from "node:crypto";

// Committed after first CI run. Replace placeholder with actual hex before merge.
const LONG_RUN_GOLDEN_SHA256 = "PLACEHOLDER_REPLACE_AFTER_FIRST_CI_RUN";

describe("10k-tick determinism golden (DET-02)", () => {
  it("simulate({ seed: 42, durationTicks: 10000 }) produces a committed SHA-256 hash", () => {
    const stream = simulate({ seed: 42, durationTicks: 10000 });
    const hash = createHash("sha256").update(JSON.stringify(stream)).digest("hex");
    expect(hash).toBe(LONG_RUN_GOLDEN_SHA256);
  });
});
```

**`createHash` import:** `node:crypto` (built-in, no install needed). Not currently used in test files — it IS used in `packages/optimizer/src/rolling/freeze-idempotency.ts` as the pattern to copy from:
```typescript
import { createHash } from "node:crypto";
// usage:
createHash("sha256").update(JSON.stringify(stream)).digest("hex")
```

---

### `packages/api/test/lru-map.unit.test.ts` — **NEW FILE**

**Analog:** `packages/api/test/ws-rejection.test.ts` (pure unit, no Postgres) — file-level structure; `packages/api/test/plan.test.ts` — pure unit with stub DB pattern.

**File structure to copy** (`ws-rejection.test.ts:1-2`):
```typescript
import { describe, expect, it } from "vitest";
// Import from local source (not a dist barrel) for the unit project:
import { LruMap } from "../src/optimizer/lru-map.js";
```

**Test shape for LruMap:**
```typescript
describe("LruMap (CONT-04c)", () => {
  it("get returns undefined for a missing key", () => { ... });
  it("get returns the value for a present key", () => { ... });
  it("set and get round-trip", () => { ... });
  it("evicts the least-recently-used entry when cap is exceeded", () => {
    const m = new LruMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);              // evicts "a" (LRU)
    expect(m.get("a")).toBeUndefined();
    expect(m.get("b")).toBe(2);
    expect(m.get("c")).toBe(3);
  });
  it("get moves the accessed key to MRU (evicts the other when cap exceeded)", () => {
    const m = new LruMap<string, number>(2);
    m.set("a", 1);
    m.set("b", 2);
    m.get("a");                 // "a" is now MRU; "b" is LRU
    m.set("c", 3);              // evicts "b" (LRU)
    expect(m.get("b")).toBeUndefined();
    expect(m.get("a")).toBe(1);
    expect(m.get("c")).toBe(3);
  });
  it("size reflects current entry count (capped at cap)", () => { ... });
  it("set on existing key updates the value and moves to MRU", () => { ... });
});
```

---

## Shared Patterns

### Test imports (unit tests — `*.unit.test.ts`)

**Source:** `packages/simulation/test/determinism.unit.test.ts:1-3`
**Apply to:** All new `*.unit.test.ts` files
```typescript
import { describe, expect, it } from "vitest";
// Add afterEach/beforeEach only when needed (see ws-rejection.test.ts)
```

### `node:crypto` for SHA-256

**Source:** `packages/optimizer/src/rolling/freeze-idempotency.ts` (existing usage)
**Apply to:** New DET-02 10k golden block in `determinism.unit.test.ts`
```typescript
import { createHash } from "node:crypto";

const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
```

### WsEnvelope field extension pattern

**Source:** `packages/api/src/ws/envelope.ts:218-220` — how `speed: SimSpeedState` was added
**Apply to:** `simDay: number` addition on `WsEnvelope`

Pattern: add to BOTH union members simultaneously, at the envelope level, NOT inside the payload types. The field bypasses `diffTick` (which only operates on `SnapshotPayload` / `TickPayload`).

### Sim-day derivation

**Source:** RESEARCH.md VQ#7 + engine.ts `EPOCH_ISO` constant
**Apply to:** `packages/api/src/ws/snapshots.ts` broadcast closure
```typescript
const EPOCH_MS = Date.parse("2026-04-01T00:00:00.000Z"); // must match engine.ts EPOCH_ISO
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// in broadcast(simMs):
const simDay = Math.floor((simMs - EPOCH_MS) / MS_PER_DAY);
```
NEVER use `Date.now()` — must come from the `simMs` parameter (deterministic virtual clock).

### Backpressure guard placement

**Source:** `packages/api/src/ws/snapshots.ts:651-653` (sendRawIfOpen)
**Apply to:** `sendRawIfOpen` only — NOT the initial snapshot path
The `ws` library's server-side `WebSocket` object exposes `bufferedAmount` as a standard property (same as browser API).

### UI: consuming a scalar from WsEnvelope

**Source:** `packages/web/src/panels/SpeedControl.tsx:109-121` — how `envelope.speed` is consumed from WsContext
**Apply to:** `simDay` display component (CONT-03 UI surface)
```typescript
// In a panel component:
useEffect(() => {
  const unsub = registry.subscribe((envelope) => {
    const next = envelope.simDay;  // new scalar field, same as envelope.speed
    if (next === lastRef.current) return;  // skip re-render on no change
    lastRef.current = next;
    setSimDay(next);
  });
  return unsub;
}, [registry]);
```
Pattern: subscribe via `registry.subscribe()` from `WsContext`; store previous value in a ref to skip spurious re-renders; `useState` for the displayed integer.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `packages/api/src/optimizer/lru-map.ts` | utility | CRUD | No LRU utility exists in the repo; ~30 LOC custom using ES6 Map insertion order |

---

## Metadata

**Analog search scope:** `packages/simulation/`, `packages/api/`, `packages/web/src/`
**Files read:** 16 source files + 4 test files
**Pattern extraction date:** 2026-06-24

**Critical implementation guards (from RESEARCH.md):**
1. `durationTicks` stop path MUST remain byte-identical when `runUntilStopped` is false or absent.
2. Self-rescheduling guards at engine.ts:722 and engine.ts:1166 MUST be conditioned on `!runUntilStopped`, NOT removed.
3. `simDay` derived from `simMs` (virtual clock), never `Date.now()`.
4. `bufferedAmount` guard applies in `sendRawIfOpen` for tick deltas only; initial snapshot and resync responses are unguarded.
5. `LruMap.get()` must move the accessed key to MRU position (Map delete + re-set).
6. `simulate()` and `runSimulation()` wrappers remain unchanged (golden-test surface).
7. `driveSimulationOpenEnded()` must NOT call `simulate()` upfront (would OOM on infinite stream).
