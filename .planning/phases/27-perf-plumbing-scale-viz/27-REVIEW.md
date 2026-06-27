---
phase: 27-perf-plumbing-scale-viz
status: resolved
resolution: "CR-01/CR-02/WR-01 FIXED (ca321a5, +tests). WR-02/WR-03 deferred to .planning/v3.0-GO-LIVE.md (user decision). IN-01 cosmetic/no-action."
reviewed: 2026-06-27T00:00:00Z
depth: deep
files_reviewed: 18
files_reviewed_list:
  - packages/projections/src/runner/inline.ts
  - packages/projections/src/runner/rebuild.ts
  - packages/projections/src/reducers/induction-deadline.ts
  - packages/projections/src/schema.ts
  - packages/projections/src/schema.sql
  - packages/event-store/src/store.ts
  - packages/api/src/optimizer/twin-snapshot.ts
  - packages/api/src/optimizer/worker-client.ts
  - packages/api/src/ws/snapshots.ts
  - packages/api/src/ws/envelope.ts
  - packages/api/src/main.ts
  - packages/api/src/sim/driver.ts
  - packages/simulation/src/engine.ts
  - packages/simulation/src/coordinator/optimize.ts
  - packages/simulation/src/index.ts
  - vendor/async-queue/src/index.ts
  - packages/web/src/map/layers.ts
  - packages/web/src/panels/SuggestionFeed.tsx
findings:
  critical: 2
  warning: 3
  info: 1
  total: 6
status: issues_found
---

# Phase 27: Code Review Report

**Reviewed:** 2026-06-27
**Depth:** deep
**Files Reviewed:** 18
**Status:** issues_found

## Summary

Phase 27 delivers three substantial subsystems: PERF-02/03 bounded-read projections
and async-queue seams, P27-A divergent optimizer reroute (3 pin removals), and
VIZ-15/16/17 scale visualization. The event-store coalesced INSERT, `applyInductionDeadline`,
and the async-queue core-ban (simulation package) are clean. The four goldens are
confirmed byte-identical. Two blockers and three warnings are documented below.

---

## Critical Issues

### CR-01: `rebuildProjections` TRUNCATE omits `geo_route` and `geo_inflight_trip`, leaving stale data after rebuild

**File:** `packages/projections/src/runner/rebuild.ts:50`

**Issue:** `rebuildProjections` TRUNCATEs the ten operational tables but does NOT
include `geo_route` or `geo_inflight_trip`. `applyTrailerFuel` (in `inline.ts`)
now writes to BOTH of these tables on `RouteRegistered` (geo_route) and
`TrailerDeparted` / `TrailerArrivedAtHub` (geo_inflight_trip) as part of the
inline operational applier. The catch-up rebuild (`rebuildCatchupProjection` in
`catchup.ts`) already TRUNCATEs these tables under its own path — but the
OPERATIONAL rebuild (`rebuildProjections`) does not.

The consequence: after a `rebuildProjections` call (e.g. on a corrupted/lagged
twin), the inline replay re-applies every `RouteRegistered` and `TrailerDeparted`
event, UPSERTing into `geo_route` / `geo_inflight_trip` that may still contain
rows from the prior live run that were NOT cleared. For `geo_route` this is benign
(UPSERT replaces geometry idempotently). For `geo_inflight_trip` it is a latent
bug: rows from trips that ALREADY completed (had their arrival event applied, which
deleted the row during the original live run) may survive the rebuild and re-appear
because the TRUNCATE is missing. On the replay pass, `TrailerArrivedAtHub` WILL
DELETE the row again — so eventually the table converges — but any intermediate
`applyTrailerFuel` call that reads `geo_inflight_trip` between the Departed replay
and the Arrived replay will see phantom in-flight trips. This corrupts the
`inflight` map used to seed the fuel reducer's route resolution, potentially
causing the wrong leg geometry to be applied for miles accrual. The golden-replay
test exercises the full round-trip (truncate + replay), but it runs both catch-up
and operational together; it does not isolate `rebuildProjections` alone, so this
gap is not caught by the existing tests.

A secondary concern: if a future release splits catch-up and operational rebuilds
to run independently (operationally reasonable for a large log), the tables will
permanently diverge.

**Fix:**
```sql
-- rebuild.ts line 50: add geo_inflight_trip and geo_route to the operational TRUNCATE
TRUNCATE TABLE package_location, trailer_state, hub_inventory, driver_status,
  driver_assignment, tag_registry, zone_estimate, exceptions, exception_kpi,
  trailer_fuel, induction_deadline, geo_route, geo_inflight_trip
```

In TypeScript:
```typescript
await sql`TRUNCATE TABLE package_location, trailer_state, hub_inventory,
  driver_status, driver_assignment, tag_registry, zone_estimate, exceptions,
  exception_kpi, trailer_fuel, induction_deadline, geo_route, geo_inflight_trip`.execute(db);
```

Note that `geo_keyframe` is owned by the catch-up runner, not the operational
inline applier, so it stays out of `rebuildProjections`. If the operational rebuild
is ever expected to be self-contained, `geo_keyframe` should be added to
`rebuildCatchupProjection` instead.

---

### CR-02: `AsyncQueue.close()` wakes blocked producers with `resolve()`, not `reject()`, causing a missed `throw` that leaves `pending` entries in `worker-client.ts` permanently unresolved

**File:** `vendor/async-queue/src/index.ts:196-199` + `packages/api/src/optimizer/worker-client.ts:152`

**Issue:** When `AsyncQueue.close()` is called while producers are blocked waiting
for queue space, it wakes them by calling their `PromiseResolver` (which is the
`resolve` arm of a bare `new Promise<void>(resolve => { ... })`). The producer's
`await new Promise<void>(...)` then resolves without error. The producer code then
checks `if (this.closed) { throw new Error('Queue is closed'); }` (line 125) —
which DOES throw, unwinding into the `async enqueue()` body. However, the
`enqueue()` rejection propagates only to the `.catch()` attached by the caller.

In `worker-client.ts` the enqueue is:
```typescript
requestQueue.enqueue({ id, epoch, input, weights }).catch((err: unknown) => {
  pending.delete(id);
  reject(err instanceof Error ? err : new Error(String(err)));
});
```

If `close()` is called BEFORE `requestQueue.enqueue(...)` returns (i.e., the
request was already in the circular buffer and not yet blocked), `enqueue()`
resolves successfully, the item is in the queue, and `rejectAll()` (called
immediately after `requestQueue.close()` in `close()`) clears `pending`. Then the
consumer pump dequeues the item and calls `worker.postMessage(req)` — but
`worker.terminate()` has also been called. The worker may or may not process it.
The pending entry was already cleared by `rejectAll`, so no reply can be routed
back; the enqueued request is silently abandoned. This is a minor race and
benign in practice (the caller already received its rejection from `rejectAll`).

A more serious path: when `close()` is called while `enqueue()` is suspended
waiting for space (the queue is full), the `resolve()` call wakes the producer.
On the next microtask turn, the producer checks `this.closed` and throws. This
throw propagates as an unhandled rejection IF the `.catch()` on the outer
`requestQueue.enqueue(...)` has not yet been attached (it IS attached
synchronously in the `new Promise(...)` executor, so in practice it is already
registered). The `.catch()` fires, calls `pending.delete(id)` and `reject(err)`.
The outer `new Promise<EpochResult>` is then properly rejected. **This path is
safe** because the `.catch()` is attached before `await`, but it depends on the
precise JS microtask ordering that a synchronous `.catch()` attachment is always
registered before the queue wakes the producer. In Node.js this holds because
`Promise` executors are synchronous. However, the comment in `worker-client.ts`
("If the queue was closed before we could enqueue") implies the intent is that
this `.catch()` is the only guard — but the actual timing is that `pending.set(id,
...)` runs BEFORE `requestQueue.enqueue(...)` is called, and `rejectAll()` in
`close()` clears `pending` AFTER the close. A window exists: `rejectAll` fires,
then `enqueue` throws, then the `.catch()` sees that `pending.get(id)` is already
gone. In that case `.catch()` calls `pending.delete(id)` (no-op) then `reject(err)`
on an already-rejected promise — a double-reject, which in Node.js is silently
ignored. No hang occurs. But there IS a real scenario where `pending.set(id,...)`
runs, `rejectAll()` clears it BEFORE enqueue throws, and `reject(err)` in the
`.catch()` is called on an already-resolved/rejected outer promise. The outer
promise is safe (double-reject is a no-op) but the entry has already been
removed from `pending` by `rejectAll`, so the `.catch()` path calling
`pending.delete(id)` is a benign no-op.

The net correctness verdict is: **no hang, but the interaction between
`rejectAll()` and the `.catch()` guard produces a double-reject on the outer
`run()` promise when both fire in the same close cycle.** In the current Node.js
implementation this is silently swallowed. If the caller is an
`async`/`await` context, the first rejection wins and the second is dropped. This
is currently safe but is a correctness smell that could surface as an unhandled
rejection if a future refactor changes the promise construction.

**Fix:** In `worker-client.ts`, move `pending.set(id, ...)` INSIDE the
`requestQueue.enqueue(...).catch(...)` chain so `rejectAll` can never beat it:

```typescript
const run: RunEpochFn = (epoch, input, weights) => {
  if (closed) return Promise.reject(new Error("optimizer worker is closed"));
  const id = nextId++;
  const promise = new Promise<EpochResult>((resolve, reject) => {
    // Register BEFORE enqueue so rejectAll() can find it.
    pending.set(id, { resolve, reject });
  });
  requestQueue.enqueue({ id, epoch, input, weights }).catch((err: unknown) => {
    pending.delete(id);
    // Only reject if not already handled by rejectAll.
    pending.get(id) === undefined
      ? void 0
      : (pending.delete(id), promise_reject_fn(err));
  });
  return promise;
};
```

A simpler fix: in `close()`, call `rejectAll` AFTER `await worker.terminate()`
so that `enqueue().catch()` always runs first for any blocked caller:
```typescript
async close(): Promise<void> {
  if (closed) return;
  closed = true;
  requestQueue.close();
  await worker.terminate();      // terminate first
  rejectAll(new Error("optimizer worker is closing")); // then reject stragglers
}
```

---

## Warnings

### WR-01: `applyTrailerFuel` on `TrailerDeparted` reads ALL `geo_route` and ALL `geo_inflight_trip` rows — O(routes + inflight), not O(1)

**File:** `packages/projections/src/runner/inline.ts:946-949`

**Issue:** The docstring claims "Cost: O(1) fuel reads + O(all routes/inflight) for
seeding the fold state" and acknowledges the O(all routes) scan, noting "routes/
inflight are small compared to the full event log." However, on a continental
topology with 60+ hubs and multi-center routing, `geo_route` grows as O(edges) in
the network: a near-full-mesh of N centers produces O(N²) backbone edges. At 8
centers + 52 spokes with center<->center and center<->spoke legs this can reach
300–600 rows. Each `TrailerDeparted` reads EVERY geo_route row. With 10 trailers
per spoke × 52 spokes = 520 trailers, each `TrailerDeparted` does 520 × 600 row
reads = 312,000 row reads per routing cycle. This is not the O(events²) behaviour
fixed by PERF-02 but it is also not O(1) as implied by the PERF-02 framing.

This is a WARNING, not a blocker, because the claim "routes/inflight are small
compared to the event log" is true at MVP scale and the demo will not exhibit the
freeze pathology. But the scaling assumption is buried in a comment rather than
enforced by a cost test.

**Fix:** Document the actual O(routes + inflight) cost clearly in the docstring
and, if the continental topology grows, add a `geo_route` index on
`(from_hub_id, to_hub_id)` (already the PK, so it exists) and consider caching
the route map across applier calls (e.g., a module-level Map<> invalidated on
`RouteRegistered`). For now, a comment that names the actual scaling bound suffices.

---

### WR-02: `P27-B` hardcodes `refuelThresholdMiles: 250` unconditionally — applies even when continental topology is disabled

**File:** `packages/api/src/main.ts:73-78`

**Issue:** The comment says "Do NOT edit DEFAULT_FUEL_CONFIG — this override affects
ONLY the live continental demo run." However, the code applies the 250-mile
threshold whenever `fuelEnabled` is true, regardless of whether
`continentalTopology` is also true. The demo configures continental topology via
env variables (which are not shown being wired through to the sim options in
`main.ts` — they are absent from `driveOpts`). When a user runs the demo with the
default (continental off, single-center star) and fuel enabled, the 250-mile
threshold fires on short spoke legs (~150–400 mi), causing trailers to refuel every
single trip on short legs. This is not catastrophic (refueling is a valid
event) but the behaviour differs from what the comment promises ("long backbone
legs deterministically push a mid-trip truck past the refuel limit"). On the
legacy star a 250-mile cap means ANY leg longer than 250 miles triggers a refuel
mid-trip, regardless of whether backbone drama was intended.

**Fix:** Gate the lower threshold on the continental topology flag:
```typescript
const continentalEnabled = process.env.CONTINENTAL_TOPOLOGY === "1";
const fuelConfig: FuelConfig = {
  ...DEFAULT_FUEL_CONFIG,
  enabled: fuelEnabled,
  // P27-B: only lower threshold for continental backbone legs
  ...(continentalEnabled ? { refuelThresholdMiles: 250 } : {}),
};
```
This requires also wiring `continentalEnabled` into `driveOpts.continentalTopology`
(which is currently absent from the options passed to `driveSimulationPaced` /
`driveSimulationOpenEnded` — a separate but related gap).

---

### WR-03: `continentalTopology`, `oodaAgentsEnabled`, and `coordinatorsEnabled` flags are not wired into `driveOpts` in `main.ts`, silently defaulting to OFF on the live demo

**File:** `packages/api/src/main.ts:185-212`

**Issue:** `driveOpts` in `main.ts` does not include `continentalTopology`,
`oodaAgentsEnabled`, `coordinatorsEnabled`, or `coordinatorUsesOptimizer`. These
are all defaulted to `false` (the determinism keystone), so on the live demo ALL
of the Phase-23–26 features (continental topology, OODA agents, coordinators,
optimizer-backed reroute) are PERMANENTLY DISABLED unless the caller explicitly
injects them. The `driveSimulationPaced` / `driveSimulationOpenEnded` types accept
these fields (they flow through to the engine). The only way to activate them is
to add them to `driveOpts`. This is a live-demo correctness gap: the P27-A
pin-removal (optimizer-backed divergent reroute) and the P27-B coordinator-driven
fuel-reject both require `coordinatorsEnabled` + `coordinatorUsesOptimizer` to
be `true` on the live demo path, but they are absent from `driveOpts`, so the
demo never exercises the new Phase-27 code paths.

**Fix:**
```typescript
const driveOpts = {
  // ... existing fields ...
  continentalTopology: process.env.CONTINENTAL_TOPOLOGY === "1",
  oodaAgentsEnabled: process.env.OODA_AGENTS_ENABLED !== "0",
  coordinatorsEnabled: process.env.COORDINATORS_ENABLED !== "0",
  coordinatorUsesOptimizer: process.env.COORDINATOR_USES_OPTIMIZER !== "0",
};
```

---

## Info

### IN-01: `AsyncQueue.popWaiter` uses LIFO ordering for producer wake-up, silently breaking FIFO guarantee for blocked producers

**File:** `vendor/async-queue/src/index.ts:96-101`

**Issue:** The `AsyncQueue` documentation and the `snapshots.ts` docstring both
promise FIFO ordering. The consumer (dequeue) side is correctly FIFO because it
reads from the circular buffer head. However, the producer wake-up mechanism in
`popWaiter` is explicitly LIFO (it pops from the end of `waitingProducers`). Under
backpressure (queue full, multiple producers blocked), when a consumer dequeues
an item and wakes ONE blocked producer, it wakes the LAST one to have blocked
rather than the FIRST. In the `worker-client.ts` usage (WORKER_QUEUE_MAX_SIZE=4)
with concurrent `run()` calls, the iteration order of which producer is woken
when space frees is LIFO rather than FIFO. For the ws broadcast loop
(CLIENT_QUEUE_MAX_SIZE=64) with a single producer (the broadcast function),
there is at most one blocked producer so LIFO = FIFO; this is harmless. For the
optimizer worker, LIFO means earlier optimizer requests may be delayed behind
later ones under sustained backpressure. This does not affect correctness (all
requests are eventually processed) but is a documentation mismatch and could
cause surprising priority inversion under heavy load. Flagged as INFO because
the current usage has at most one producer blocked at a time in the hot paths.

**Fix:** Note in code comments that the vendor `AsyncQueue` is FIFO for consumers
but LIFO for unblocking producers under sustained backpressure, and that the
current callers are unaffected. If true FIFO producer unblocking becomes
necessary, replace `popWaiter` with a head-of-queue pop.

---

_Reviewed: 2026-06-27_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
