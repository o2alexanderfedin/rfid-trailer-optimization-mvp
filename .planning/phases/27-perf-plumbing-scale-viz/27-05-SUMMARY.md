---
phase: 27-perf-plumbing-scale-viz
plan: 05
subsystem: api
tags: [async-queue, backpressure, event-store, websocket, worker-threads, perf]

requires:
  - phase: 27-02
    provides: vendored AsyncQueue<T> built + workspace linked + DET-03 ESLint ban

provides:
  - bounded AsyncQueue<WorkerRequest> worker↔optimizer handoff (seam a, T-27-13)
  - coalesced multi-row event-store INSERTs — one round-trip per appendToStream call (seam b, T-27-14)
  - per-client bounded AsyncQueue<string> ws backpressure consumer loop (seam c, T-27-11/12)

affects: [PERF-04, ws-client, event-store-append, optimizer-worker]

tech-stack:
  added: []
  patterns:
    - "AsyncQueue<ConcreteType> consumer pump pattern: start a for-await consumer loop that dequeues + awaits an async I/O operation; close() on shutdown"
    - "Multi-row Kysely .values([array]) insert: build all row objects in order first, then one .execute() — preserves row order, one DB round-trip"
    - "Per-client Map<Socket, QueueHandle> replacing a Set<Socket>: on connect create queue+loop, on close/error close queue"

key-files:
  created:
    - packages/api/test/ws-backpressure.unit.test.ts
  modified:
    - packages/api/src/optimizer/worker-client.ts
    - packages/event-store/src/store.ts
    - packages/api/src/ws/snapshots.ts

key-decisions:
  - "WORKER_QUEUE_MAX_SIZE=4: 4 in-flight optimizer epochs is sufficient for the live-loop; bounding at 4 prevents unbounded pending Map growth without blocking normal operation"
  - "Task 2 (seam b) chose transaction-local multi-row coalescing over a cross-call AsyncQueue: the in-transaction single multi-row commit already satisfies bounded+coalesced without cross-append ordering complexity"
  - "CLIENT_QUEUE_MAX_SIZE=64: 64 frames x ~2-5KB = bounded ~128-320KB per slow client (T-27-11); the queue blocks the broadcaster rather than dropping frames"
  - "Initial snapshot + resync remain direct via sendRawIfOpen (not through the per-client queue) — Pitfall 4: a fresh socket is at bufferedAmount=0 and must receive its first snapshot unconditionally"
  - "Broadcast enqueue is fire-and-forget (catch ignored closed queue): one slow client cannot block the broadcast loop or other clients (T-27-12 per-client isolation)"

patterns-established:
  - "createClientQueue(send, maxSize): exported factory returns {enqueue, close}; consumer loop drives the async I/O; injectable send callback enables unit testing without a real WebSocket"
  - "AsyncQueue pump for worker handoff: consumer pump as a fire-and-forget async IIFE with for-await-of; pump error caught silently (error/exit handlers cover rejectAll)"

requirements-completed: [PERF-03]

duration: 65min
completed: 2026-06-27
---

# Phase 27 Plan 05: PERF-03 Runtime Plumbing Seams Summary

**Three bounded FIFO runtime seams via AsyncQueue: worker↔optimizer epoch backpressure, coalesced multi-row event-store INSERTs, and per-client ws queue replacing the drop-based 256KB gate**

## Performance

- **Duration:** ~65 min
- **Started:** 2026-06-27T06:40:00Z
- **Completed:** 2026-06-27T07:45:04Z
- **Tasks:** 3
- **Files modified:** 4 (+ 1 created)

## Accomplishments

- Seam (a): `worker-client.ts` — `AsyncQueue<WorkerRequest>(maxSize=4)` bounds the previously-unbounded `pending` Map; the `run()` function now `await queue.enqueue(request)` backpressuring the live-loop instead of growing in-flight epochs; reply-correlation and `rejectAll` guards preserved
- Seam (b): `event-store/src/store.ts` — per-event awaited INSERT loop replaced with single coalesced `insertInto("events").values([...rows]).execute()` in both `appendToStream` and `append`; `lockGlobalOrder + casStreamVersion + UNIQUE backstop` remain in the same transaction; append-order preserved (rows built in version-increment order before execute)
- Seam (c): `ws/snapshots.ts` — drop-based `shouldSendToSocket` 256KB skip replaced with per-client `createClientQueue(send, maxSize=64)` factory; each connected socket gets a bounded queue + consumer loop; broadcast enqueues wire strings per client (fire-and-forget isolation); initial snapshot + resync remain direct (Pitfall 4); `ws-backpressure.unit.test.ts` asserts FIFO + backpressure + per-client isolation + clean shutdown

## Task Commits

1. **Task 1: seam (a) worker↔optimizer handoff bounded** — `6d53caf` (feat)
2. **Task 2: seam (b) event-store multi-row INSERT coalescing** — `7c57f72` (feat)
3. **Task 3: seam (c) per-client ws backpressure queue** — `b72f439` (feat, TDD GREEN)

## Files Created/Modified

- `packages/api/src/optimizer/worker-client.ts` — `AsyncQueue<WorkerRequest>` pump wrapping `postMessage`; `WorkerRequest` interface; `WORKER_QUEUE_MAX_SIZE=4`
- `packages/event-store/src/store.ts` — multi-row `.values([...])` coalescing in `appendToStream` + `append`
- `packages/api/src/ws/snapshots.ts` — `createClientQueue` export; `ClientQueueHandle` interface; `CLIENT_QUEUE_MAX_SIZE=64`; `clientQueues Map<WebSocket,ClientQueueHandle>` replacing `clients Set<WebSocket>`; broadcast via per-client `enqueue`
- `packages/api/test/ws-backpressure.unit.test.ts` — 4 TDD acceptance tests (FIFO, backpressure, isolation, shutdown)

## Decisions Made

- **Task 2 — no AsyncQueue needed across appends**: the plan allowed a transaction-local coalescing approach if it satisfies "bounded + coalesced" without a cross-call queue. The multi-row insert inside the existing transaction is already bounded (one DB round-trip per `appendToStream` call, not one per event), so no additional `AsyncQueue` was introduced in the event-store. Documented per plan instructions.
- **Isolation test design**: the TDD isolation test (#3) needed to match real broadcast usage: one frame per tick enqueued to all clients independently (fire-and-forget), not all frames launched concurrently from a single producer. Concurrent multiple producers from a single goroutine expose the LIFO waiter wakeup in AsyncQueue, which does not affect real-world single-frame-per-tick broadcast usage.

## Deviations from Plan

None — plan executed exactly as written. The "no AsyncQueue across appends" choice was explicitly pre-authorized by the plan ("if the in-transaction single multi-row commit already satisfies 'bounded + coalesced' without a cross-call queue, keep it transaction-local and note that in the SUMMARY").

## Known Stubs

None.

## Threat Flags

None — all three seam changes are internal plumbing (no new network endpoints, no new auth paths, no new file access patterns). The threat mitigations T-27-11/12/13/14 from the plan's `<threat_model>` are now implemented.

## Issues Encountered

- **Isolation test LIFO ordering** (found during TDD GREEN, fixed in same commit): the first isolation test design enqueued all 6 frames concurrently per client with `frames.map(f => slowHandle.enqueue(f))`. With `maxSize=2`, frames 2-5 all blocked as producers; when a consumer slot opened, the LAST blocked producer was woken (AsyncQueue uses LIFO for waiter queues for O(1) performance). Fixed by matching real broadcast usage pattern: one frame at a time, fire-and-forget per client.

## Self-Check: PASSED

- FOUND: packages/api/src/optimizer/worker-client.ts (contains `AsyncQueue<WorkerRequest>`)
- FOUND: packages/event-store/src/store.ts (contains `.values([` for multi-row INSERT)
- FOUND: packages/api/src/ws/snapshots.ts (contains `AsyncQueue<string>` + `createClientQueue`)
- FOUND: packages/api/test/ws-backpressure.unit.test.ts (4 acceptance tests)
- Commits 6d53caf, 7c57f72, b72f439 verified in git log
- 357 unit tests pass; 33 determinism goldens byte-identical

## Next Phase Readiness

- All three PERF-03 runtime seams bounded, FIFO, and O(1)
- API and event-store build cleanly; 357 unit tests pass; goldens byte-identical (33 determinism tests pass)
- ESLint DET-03 ban holds: no `async-queue` imports in `packages/simulation/src/`
- PERF-04 (sustained continental-run validation) can proceed

---
*Phase: 27-perf-plumbing-scale-viz*
*Completed: 2026-06-27*
