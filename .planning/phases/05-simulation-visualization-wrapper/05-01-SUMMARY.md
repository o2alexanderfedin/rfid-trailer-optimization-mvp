---
phase: 05-simulation-visualization-wrapper
plan: 01
subsystem: ws-envelope
type: tdd
tags: [ws, protocol, viz-04, envelope, diff, realtime]
dependency_graph:
  requires: []
  provides: [WsEnvelope, diffTick, SnapshotPayload, TickPayload, versioned-ws-channel]
  affects: [apps/web, packages/api/src/ws, packages/api/src/sim/driver]
tech_stack:
  added: []
  patterns:
    - versioned discriminated union (v:1) for forward-compatible ws protocol
    - diffTick pure builder (data-in/data-out, unit-testable without DB)
    - buffered WebSocket receiver in tests (eliminates connect→message race)
    - SnapshotPayloadBuilder injectable port (DIP, no live DB for unit tests)
key_files:
  created:
    - packages/api/src/ws/envelope.ts
    - packages/api/src/ws/envelope.test.ts
    - packages/api/src/ws/snapshots.test.ts
  modified:
    - packages/api/src/ws/snapshots.ts
    - packages/api/src/index.ts
    - packages/api/src/sim/driver.ts
    - packages/api/test/ws-rejection.test.ts
    - packages/api/test/ws.int.test.ts
decisions:
  - Buffered WebSocket receiver for unit tests: sets up "message" listener before
    "open" fires so the test never races with the server's async initial-snapshot send.
  - diffTick is pure (no I/O, no Date.now) — fully unit-testable without a DB.
  - KPI / route buckets zeroed in buildSnapshotPayload until Plan 05-03 wires them.
  - simMs for broadcast is derived from the tick's domain occurredAt timestamp (ISO→ms).
  - Legacy shims kept in snapshots.ts (deprecated) for the migration window.
metrics:
  duration: ~70 minutes
  completed: "2026-06-19T22:13:02Z"
  tasks: 2
  files_created: 3
  files_modified: 5
  tests_added: 31
  tests_total_green: 554
---

# Phase 05 Plan 01: VIZ-04 Versioned WS Envelope Summary

**One-liner:** Versioned ws keyframe+delta envelope (v:1 snapshot/tick with seq+simMs and pure diffTick) replacing the legacy `{ t:'snapshot' }` wire shape — the protocol contract that all Phase-5 frontend animation, coloring, and KPI panels consume.

## What Was Built

### `packages/api/src/ws/envelope.ts` (new)
The canonical VIZ-04 wire types:
- `WsEnvelope` — discriminated union `{ v:1, type:"snapshot"|"tick", seq, simMs, payload }`
- `SnapshotPayload` — full baseline (trailers, hubs, routes, kpis, exceptionsOpen)
- `TickPayload` — per-tick delta (optional fields: trailers?, trailersGone?, hubs?, routes?, kpis?, exceptionsNew?, exceptionsResolved?, planChanges?)
- `TrailerKeyframe`, `HubState`, `RouteState`, `ExceptionItem`, `PlanDelta`, `KpiSnapshot` — entity types
- `diffTick(prev, next): TickPayload` — pure delta builder, sorts by id for P3 determinism, returns empty `{}` when nothing changed (zero-noise invariant / T-01-19)

### `packages/api/src/ws/snapshots.ts` (rewritten)
- `attachSnapshotSocket` now emits the versioned envelope
- On connect: `{ v:1, type:"snapshot", seq:1, simMs:0, payload }` from `buildSnapshotPayload`
- Per `broadcast(simMs)`: `{ v:1, type:"tick", seq:N, simMs, payload:diffTick(prev,current) }`
- `SnapshotPayloadBuilder` port injectable for tests (DIP — no live DB needed)
- All M-5 discipline preserved: fire-and-forget `.catch` on initial send, close on error
- `Broadcast` type updated to `(simMs: number) => Promise<WsEnvelope>`
- `buildSnapshotPayload`: maps geo-track keyframes → TrailerKeyframe, hubs → HubState, open exceptions → ExceptionItem; routes/KPIs zeroed (filled by Plans 05-03)

### `packages/api/src/index.ts`
Re-exports all VIZ-04 wire types (`WsEnvelope`, `SnapshotPayload`, `TickPayload`, `TrailerKeyframe`, `HubState`, `RouteState`, `ExceptionItem`, `PlanDelta`, `KpiSnapshot`, `diffTick`) so `@mm/web` imports them from `@mm/api`.

### `packages/api/src/sim/driver.ts`
Updated `broadcast()` call to `broadcast(tickMs)` where `tickMs = new Date(tick[0].occurredAt).getTime()` — passes the domain timestamp as the authoritative sim clock.

## TDD Gate Compliance

| Gate | Commit | Status |
|------|--------|--------|
| RED (envelope.test.ts) | a310fd4 | PASS — 21 tests failing on missing module |
| GREEN (envelope.ts) | 6c9140b | PASS — 21 tests green |
| RED (snapshots.test.ts) | 4b5ad7b | PASS — 10 tests failing on missing types |
| GREEN (snapshots.ts rewrite) | 3cc81e9 | PASS — 10 tests green |

## Test Results

- **envelope.test.ts**: 21 tests, all pass
  - diffTick upsert/delete for trailers (routeId, departMs, etaMs, state, util changes)
  - Hub/route bucket diff (only changed buckets emitted)
  - Exception new/resolved sets
  - KPI partial diff (only changed numeric fields)
  - Zero-noise invariant (empty `{}` payload when nothing changed)
  - P3 determinism (all collections sorted by id, stable across input ordering)

- **snapshots.test.ts**: 10 tests, all pass
  - Connect → `{ v:1, type:"snapshot", seq:1 }` envelope
  - Payload fields populated (trailers, hubs, routes, exceptionsOpen, kpis)
  - `broadcast(simMs)` → `{ v:1, type:"tick" }` delta
  - seq monotonically increments (1, 2, 3, ...)
  - simMs on tick matches the value passed to `broadcast()`
  - Tick delta carries only changed entities (diffTick integration)
  - Unchanged tick sends empty payload `{}`
  - T-01-19: exactly one message per broadcast() invocation
  - M-5: rejecting payload builder closes socket, no unhandled rejection

- **ws-rejection.test.ts**: 1 test (updated `buildSnapshot` → `buildPayload`), passes
- **Total unit tests**: 554 passing

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Race condition between server async send and test listener setup**
- **Found during:** Task 2 initial test run
- **Issue:** The server's initial snapshot is sent in a Promise `.then()` microtask; tests using `socket.once("open", ...)` → `socket.once("message", ...)` occasionally received the message before the listener was set up (non-deterministic timeout failures on tests 2, 5, 7 in first run)
- **Fix:** Replaced `openSocket` / `nextMessage` with `openSocketBuffered` that attaches the "message" listener before the "open" handler resolves. Messages are queued in `buf[]` and drained by `next()` calls.
- **Files modified:** `packages/api/src/ws/snapshots.test.ts`

**2. [Rule 2 - Missing critical update] driver.ts broadcast signature mismatch**
- **Found during:** Task 2 build (`tsc -b`), line 211: `opts.broadcast()` called with 0 args
- **Issue:** New `Broadcast = (simMs: number) => Promise<WsEnvelope>` requires `simMs`
- **Fix:** Derive `simMs` from `tick[0]!.occurredAt` (the domain timestamp ISO string → `.getTime()`), pass as `broadcast(tickMs)`
- **Files modified:** `packages/api/src/sim/driver.ts`

**3. [Rule 2 - Missing critical update] ws-rejection.test.ts used old `buildSnapshot` option**
- **Found during:** Task 2 — `buildSnapshot` option was renamed to `buildPayload` in the rewrite
- **Fix:** Updated option key from `{ buildSnapshot }` to `{ buildPayload }` and description updated
- **Files modified:** `packages/api/test/ws-rejection.test.ts`

**4. [Rule 2 - Missing critical update] ws.int.test.ts used old SnapshotMessage wire shape**
- **Found during:** Task 2 — integration test checked `snap.t`, `snap.trailers[n].trailerId`, `snap.hubs` from the old `{ t:'snapshot' }` format
- **Fix:** Updated to use `WsEnvelope`, `env.type`, `env.payload.trailers[n].id`, and the new buffered socket helper
- **Files modified:** `packages/api/test/ws.int.test.ts`

## Known Stubs

| Stub | File | Reason |
|------|------|--------|
| `routes: []` in SnapshotPayload | `packages/api/src/ws/snapshots.ts:L249` | Plan 05-03 adds route metric buckets; no RouteRegistered-based slaRiskBucket computation yet |
| `kpis: ZEROED_KPIS` | `packages/api/src/ws/snapshots.ts:L252` | Plan 05-03 wires the KPI computation pipeline (Phase-2 load-planner scores + Phase-3 exception counts) |
| Hub buckets: `volumeBucket:0, slaRiskBucket:0, congestionBucket:0` | `packages/api/src/ws/snapshots.ts:L240` | Plan 05-02/05-03 computes metric buckets from exception counts and inventory |
| `state: "onTime"` default for all trailers | `packages/api/src/ws/snapshots.ts:L219` | State coloring requires bucket computation from trip plans; VIZ-03 fills this |

These stubs do not block the plan's stated goal (VIZ-04 envelope contract delivery) — the wire shape, seq+simMs stamping, and diffTick delta mechanism are all complete and tested. Downstream plans fill the semantic content.

## Threat Surface Scan

No new trust boundaries introduced. The envelope carries only bucketed metrics + ids as specified in T-05-01 (no raw PII). The one-message-per-tick invariant satisfies T-05-02. The `seq` counter is a drop-detector only (T-05-03 accepted for MVP).

## Self-Check

### Files exist
- `/Volumes/Unitek-B/Projects/jobs/intelliswift/packages/api/src/ws/envelope.ts` — FOUND
- `/Volumes/Unitek-B/Projects/jobs/intelliswift/packages/api/src/ws/envelope.test.ts` — FOUND
- `/Volumes/Unitek-B/Projects/jobs/intelliswift/packages/api/src/ws/snapshots.test.ts` — FOUND
- `/Volumes/Unitek-B/Projects/jobs/intelliswift/packages/api/src/ws/snapshots.ts` — FOUND (rewritten)
- `/Volumes/Unitek-B/Projects/jobs/intelliswift/packages/api/src/index.ts` — FOUND (updated)

### Commits exist
- `a310fd4` test(05-01): add failing tests for versioned WsEnvelope + diffTick builder (RED)
- `6c9140b` feat(05-01): implement versioned WsEnvelope types + diffTick builder (GREEN)
- `4b5ad7b` test(05-01): add failing tests for versioned ws channel (RED)
- `3cc81e9` feat(05-01): emit versioned WsEnvelope from ws channel (snapshot+tick per VIZ-04) (GREEN)

## Self-Check: PASSED
