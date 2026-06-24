# Pitfalls Research — Milestone v2.0 "Complete Simulation Model"

**Domain:** Deterministic, event-sourced discrete-event simulation — adding continuous/open-ended operation, external freight induction, outbound delivery, and bidirectional freight flow to an existing center→spoke-only bounded simulation.
**Researched:** 2026-06-23 (codebase-grounded; all file/symbol references verified)
**Confidence:** HIGH — pitfalls are grounded in the actual code (`packages/simulation/src/engine.ts`, `packages/optimizer/src/rolling/`, `packages/projections/src/`, `packages/api/src/sim/`). Generic advice excluded.

Each pitfall: warning signs → prevention strategy → owning phase/order.

---

## Critical Pitfalls

### P1 — New induction RNG substream perturbs existing seeded streams

**What goes wrong:**
Adding external induction (freight arriving from outside the network) requires new RNG draws: choosing how many packages arrive, which hub they arrive at, their size/weight, their destination. If these draws are pulled from the existing `rng` (the primary operational substream) or any of the five existing named substreams (`rfidRng`, `overCarryRng`, `timingRng`, `hosRng`, `fuelRng`), every existing RNG call after the first induction draw shifts by exactly the number of induction draws consumed. The golden stream breaks silently — `durationTicks`-old fixtures will still pass (`simulate` returns before the new code runs), but `hosEnabled` / `overCarry` / `rfid` golden-fixture tests will drift.

**Why it happens:**
The engine already has six named substreams (see `engine.ts` lines 71–93, `RFID_RNG_SALT` through `FUEL_RNG_SALT`), and the pattern is well-established — but under time pressure it is tempting to add draws to the existing `rng` ("it's just one pick") or to reuse a substream that "isn't busy" at induction time. The collision is not detected until the `determinism.unit.test.ts` golden diverges.

**How to avoid:**
Assign a new salt constant `INDUCTION_RNG_SALT` that is provably distinct from all six existing salts — extend the existing salt-collision assertion test to cover seven salts pairwise. Construct `inductionRng = makeRng((seed ^ INDUCTION_RNG_SALT) >>> 0)` at the top of `generate()`, gated on `inductionEnabled` exactly like `fuelRng` (construct only when on, so an off run makes zero draws). Similarly add `OUTBOUND_RNG_SALT` for any randomness in outbound delivery timing. Add a salt constant for bidirectional-flow if spoke→center consolidation needs independent draws (e.g., deciding which spoke packages to consolidate). The assertion in `engine.test.ts` must cover all new salts.

**Warning signs:**
- An existing `hosEnabled=true` or `rfid`-on golden fixture fails after adding induction.
- The `determinism.unit.test.ts` seed-42 byte-identical golden hash drifts.
- Salt value reused — the existing salt-collision test fails.

**Phase to address:** Phase 1 of v2.0 roadmap (continuous operation + induction foundation) — the salt discipline must be established before any induction RNG draw is written.

---

### P2 — Non-deterministic event ordering when induction and outbound fire at the same tick

**What goes wrong:**
Today's `EventQueue` uses an `(fireTick, seq)` total order where `seq` is a monotonically incrementing insertion counter. All events are inserted and popped in a single-threaded, sequential loop — so the ordering is fully deterministic today. Adding induction breaks this if: (a) induction events are enqueued from a source external to `generate()` (e.g., a separate async process that writes induction events to the DB while the sim is running), or (b) two scheduled callbacks fire at the same tick and one reads a Map or Set that was populated by the other, relying on JavaScript insertion order. The classic failure: spoke→center consolidation events and center→spoke distribution events land at the same tick; their relative order differs between runs if anything touches JS object key order (e.g., `Object.keys(pendingBySpoke)` without explicit sort).

**Why it happens:**
The v1 engine is single-threaded and batch-generates all events before any are persisted, which eliminates this problem. Adding "continuous" operation tempts refactoring `generate()` to be incremental (produce a rolling window of events on demand), or adding an external induction pump that writes events concurrently. Either change breaks the single-threaded total-order guarantee.

**How to avoid:**
Keep induction, outbound delivery, and bidirectional flow all within the same single-threaded `EventQueue`/`generate()` core. New event sources (induction arrivals, outbound handoffs, spoke→center departures) must be `schedule()`-calls, not external appends. The `schedule()` call allocates a monotonic `seq` via `queue.claimSeq()`, guaranteeing a stable tie-break even when two actions land at the same `fireTick`. For any new Map/Set iterated in a deterministic order, sort explicitly (as `trailerStateReducer` does with `assignedPackageIds`). Never use `for...of` over a `Map` in a context where insertion order could differ between runs.

**Warning signs:**
- Two replay runs with the same seed produce a different event order at the same tick.
- A new `for...of new Map(...)` loop without a preceding `.sort()` call.
- Any `fetch`, `setInterval`, or `Promise` introduced inside `generate()`.

**Phase to address:** Phase 1 (continuous operation foundation) — the single-threaded queue discipline must be locked in before induction events are added.

---

### P3 — Floating-point accumulation drift over indefinite long runs

**What goes wrong:**
Today's 120-tick finite run accumulates at most ~120 log-normal transit draws. In an open-ended run of thousands of ticks, the `timingRng` substream executes hundreds of thousands of `mulberry32` iterations. The individual draws are integer-arithmetic and platform-independent. However, the post-processing — `Math.round(sampleLogNormal(timingRng, params))` inside `drawTransitTicks` — involves `Math.exp` and `Math.log`, which are implementation-defined on some JS engines. If these diverge between Node versions or architectures (e.g., M-series ARM vs. x86), a finite-horizon golden hash diverges silently on CI. Over a long run, a one-tick drift in a single transit draw cascades: the trailer arrives one tick later, its return departure shifts, subsequent package batches miss the trailer, and every downstream event shifts.

**Why it happens:**
The spec's golden-replay contract (FND-04) was validated at 120 ticks, not 10,000. The log-normal sample — `median × exp(sigma × z)` where `z` is a Box-Muller transform — involves transcendentals. Node 22 on x86 and ARM produce identical results for the current golden, but this has not been validated at long horizons.

**How to avoid:**
Switch transit and dwell draws to integer arithmetic throughout: pre-compute a lookup table of discrete transit durations (e.g., 100 buckets of `[minTicks, maxTicks]` from the log-normal CDF) keyed by `rng.int(100)`. The table is a pure function of `(median, sigma)` computed once at startup; from that point all "log-normal" draws are integer arithmetic with no transcendentals in the hot path. Alternatively, clamp and round to whole minutes immediately in `sampleLogNormal` (already done via `Math.round`) and add a CI regression test comparing Node 22 x86/ARM golden hashes at 10,000 ticks.

**Warning signs:**
- Golden hash diverges on CI (ARM runner) vs. local (x86) for a long-horizon run.
- `sampleLogNormal` returns a non-integer even after `Math.round`.
- Long-run `simulate({ seed: 42, durationTicks: 10000 })` golden test added without a cross-platform CI check.

**Phase to address:** Phase 1 (continuous operation) — the long-run determinism regression test should be the acceptance gate for the continuous-operation phase.

---

### P4 — Unbounded event-log growth and full-replay cost explosion

**What goes wrong:**
Today the sim runs ~120 ticks producing a bounded event stream (~200–500 events for the typical demo scenario). `readAll` in `runner/rebuild.ts` does a full sequential scan from `global_seq = 0` on every rebuild. In an open-ended run producing 100 events/tick over 10,000 ticks, that is ~1,000,000 events in the log. A full rebuild on reconnect takes seconds. The catch-up projections (`runner/catchup.ts`) that run on every tick (`runCatchup`) page through all events from the last processed `global_seq` — currently cheap because the log is small, but as the log grows unbounded the per-tick catch-up window grows too.

**Why it happens:**
There is no snapshotting mechanism in the event store today. The projection tables (`trailer_state`, `hub_inventory`, `package_location`, etc.) ARE already the live read model — the issue is the catch-up reader's bookmark position. Over time, the gap between "last processed by catch-up" and "current end" stays small (one tick's events), but the total log keeps growing. A new WebSocket client connecting after hours of runtime triggers `buildSnapshot → readHubsFromLog` which scans the full log. Similarly the optimizer's `buildTwinSnapshot` reads from Postgres projections (not the raw log), so it is fine — but the audit-timeline catch-up projection (`reducers/audit-timeline.ts`) does a full-log read on every invoke.

**How to avoid:**
Two measures: (1) Projection checkpointing — each catch-up projection records its last `global_seq` watermark in a `projection_checkpoints` table; `runCatchup` only reads from that watermark forward, never from 0. This is the standard event-sourced snapshotting pattern and eliminates the O(log-size) per-tick cost. (2) Event-log retention / archival — after a configurable window (e.g., 24 sim-hours of events), archive old events to a `events_archive` table or delete them; projections are the live state and the archived events are only for audit replay. The demo does not need full replay from the beginning of time; it needs the last N hours for the audit timeline. Add a `VACUUM events WHERE global_seq < :watermark` scheduled process. (3) For snapshot-on-connect: `buildSnapshot` must read from the projection tables (already the case for trailer/hub/route state), not from the raw event log. Audit that every `buildSnapshot` codepath reads projections, not `readAll`.

**Warning signs:**
- `readAll(db, 0n)` called on a process that has been running for more than 30 minutes.
- `buildSnapshot` latency grows linearly with sim runtime.
- A new WS client connecting hours into a run gets a multi-second blank map before first render.
- The `audit_timeline` table grows without bound (one row per event, no pruning).

**Phase to address:** Phase 1 (continuous operation) — checkpoint infrastructure must be in place before the run is made open-ended. Retention policy in Phase 2.

---

### P5 — Projection state explosion from non-terminal package and trailer states

**What goes wrong:**
Today every package follows a deterministic lifecycle ending at `PackageArrivedAtHub` (terminal). The `package_location` projection retains one row per package forever — fine at 120 ticks (dozens of packages). In an open-ended run with continuous induction, thousands of packages accumulate in `package_location`, `hub_inventory.inbound`, `trailer_state.assignedPackageIds`, and the audit timeline. The `trailer_state` projection accumulates every trailer that has ever existed. Detection (`runDetection`) scans every package in `zone_estimate` and every `PlannedAssignment` — its O(n) cost at each tick grows with total-packages-ever-inducted, not just active packages. This is the known "detection cost scales with state size" tech debt from the v1.0 audit.

Outbound delivery makes this worse: without a real terminal state (a `PackageDeliveredOut` event that removes the package from active projections), packages that have been handed off for last-mile delivery remain in `package_location` and `hub_inventory` forever, inflating every scan.

**Why it happens:**
The projection reducers use additive semantics (new rows or upserts on each event), but the demo never introduced package retirement because the finite run naturally bounds growth. Open-ended + induction removes that natural bound.

**How to avoid:**
(1) Introduce a `PackageDeliveredOut` domain event (the outbound terminal event for v2.0). The projection reducers for `package_location`, `hub_inventory`, and `zone_estimate` must handle this event by REMOVING the package row. This transforms outbound from an additive-forever accumulation to a true lifecycle. (2) Introduce a `TrailerRetired` event or a trailer-reuse model — trailers in a continuous sim cycle continuously; only register a trailer once and rely on status transitions, not ever-growing trailer sets. (3) Scope detection to ACTIVE packages only: `runDetection` must filter `readPlannedAssignments()` and `readObserved()` to packages whose lifecycle is not yet terminal. Add an `is_active` flag to `package_location` that the detection query filters on. (4) Add a Vitest benchmark (`packages/projections/src/reducers/*.bench.ts`) that measures reducer throughput at 10,000+ package state size.

**Warning signs:**
- Detection takes > 100ms per tick after 30 minutes of continuous operation.
- `SELECT COUNT(*) FROM package_location` grows without bound.
- `hub_inventory.inbound` contains package ids of packages that were delivered out hours ago.
- `zone_estimate` table has rows for packages that no longer exist.

**Phase to address:** Phase 2 (outbound delivery) — the `PackageDeliveredOut` terminal event is the fix for the unbounded-projection problem. Detection scoping is Phase 2 hardening.

---

### P6 — Golden-replay drift as new domain events and states are added

**What goes wrong:**
Each new event type added for v2.0 (e.g., `FreightInducted`, `PackageDeliveredOut`, `ConsolidationDeparted`) goes through the `validate(event)` ingestion gate in `packages/domain/src/ingestion/validate.ts`. The discriminated union schema (`domainEventSchema`) must be extended to include the new event types. If a new event type is emitted by the sim but NOT added to the union, it is rejected at ingestion and the event store never receives it — a silent loss of events with no test failure if the golden only checks the number of non-rejected events. Worse: if the new event types are added to the union but the schema uses `.strict()` and the payload has an unrecognized field, ingestion silently rejects it on live runs while unit tests (which bypass ingestion) pass.

**Why it happens:**
The existing discipline is: every event has a Zod schema in `packages/domain/src/events/schemas.ts` and a TypeScript interface in `domain-event.ts`. New events for v2.0 must be added to BOTH. The risk is adding the TS type (so the sim typechecks) but forgetting to add the Zod schema, or forgetting to add the new schema to the `z.discriminatedUnion(...)` array in the ingestion validator.

**How to avoid:**
Add a `contract.assert.ts`-style test (the pattern already exists in `packages/domain/src/events/contract.assert.ts`) that emits every new v2.0 event type through `validate()` and asserts it is accepted. Add a test that `simulate({ ..., inductionEnabled: true })` produces at least one `FreightInducted` event and that all events in the stream pass `validate`. The ingestion gate is the final firewall — if every new event type is round-trip tested through `validate`, schema-union omissions are caught immediately.

**Warning signs:**
- `validate(event)` returns `{ ok: false }` for any event emitted by the sim.
- `domainEventSchema` in `schemas.ts` has fewer members than `DomainEvent` in `domain-event.ts`.
- A new event appears in `simulate()` output but not in the event store (DB row count mismatch vs. `out.length`).

**Phase to address:** Every phase that introduces new event types — validate-gate coverage is a phase 1 success criterion and must be re-verified each phase.

---

### P7 — Optimizer thrash and oscillation under continuous arrivals

**What goes wrong:**
In a finite run, the optimizer epochs are bounded: after the last package batch there are no more triggering events and `detectAffectedScope` returns an empty scope. In a continuous run with external induction, new freight arrives every few ticks in perpetuity. If the optimizer scope is not correctly scoped to the newly-affected hubs, every induction triggers a full-network re-optimization (all trailers, all routes). The SSP min-cost-flow over the full time-expanded graph takes O(n²) where n is active freight × route legs; at 100+ active blocks it can exceed the optimizer-worker budget per epoch. Separately, the in-memory `(epoch, scopeHash)` idempotency map (the known tech debt) is never flushed. Over thousands of epochs in a continuous run it grows without bound, leaking memory in the worker thread. Over a long run the worker's RSS climbs until Node's GC pressure causes tick-rate jitter.

**Why it happens:**
The existing `detectAffectedScope` in `packages/optimizer/src/rolling/scope.ts` computes the scope from the tick's events. The freeze-idempotency map in `rolling-service.ts` (the in-memory `Map<string, EpochResult>`) is never evicted — it was sized for a finite run. In a continuous run the map accumulates one entry per unique `(epochId:scopeHash)` pair indefinitely.

**How to avoid:**
(1) Scope discipline: `detectAffectedScope` for bidirectional freight must correctly scope to the hub(s) that received new induction events or outbound deliveries — not trigger on unrelated hub events. Add a test that an induction event at SFO does not re-scope trailers at BOS. (2) Idempotency map eviction: convert the in-memory map to an LRU cache (e.g., 500-entry cap, evict LRU on overflow) or to a Postgres-backed `optimizer_idempotency` table (fixes the restart-durability tech debt simultaneously). The LRU cap should be at least 2× the number of active hubs × trailers. (3) Freeze window: verify the freeze-window logic (`isFrozen` in `freeze-idempotency.ts`) handles bidirectional trailers correctly — a spoke→center consolidation trailer needs the same freeze semantics as a center→spoke distribution trailer. A trailer's `departureMin` must be updated when spoke→center consolidation is dispatched.

**Warning signs:**
- Worker-thread RSS grows monotonically over a multi-hour run.
- Every tick triggers a full-scope re-optimization (scope includes all trailers regardless of affected hubs).
- `isFrozen` returns `false` for a trailer that departed 5 minutes ago (stale `departureMin` in twin).

**Phase to address:** Phase 3 (bidirectional freight + optimizer awareness) — the LRU eviction and scope correctness tests should be phase 3 success criteria.

---

### P8 — Bidirectional freight starvation: empty return assumption baked into center→spoke model

**What goes wrong:**
The current engine assumes center→spoke→center cycles. In `departTrailer`, the manifest is drained from `pendingBySpoke.get(spoke.hubId)` — only center-origin packages. The return leg (`arriveTrailer` → schedule next `departTrailer`) carries only over-carried packages (the F-07 path), which is explicitly bounded to at most one package. There is no `pendingByCenter` map for spoke-originated consolidation freight. If spoke→center consolidation is modeled by simply adding packages to a `pendingByCenter` map and draining it on the return leg, the empty-return leg — where no consolidation freight exists — must still be modeled correctly: a trailer returns from a spoke empty if no consolidation freight is pending, and the center dwell fires exactly once on that return (not a second consolidation dwell). Without explicit modeling, the return leg silently carries nothing but still accrues dwell time, creating ghost-idle trailers on the map.

**Why it happens:**
The current `arriveTrailer` function hard-codes a single next departure (`schedule(nextDepart, () => departTrailer(trailerId, spoke, nextDepart))`). Adding bidirectional flow requires deciding at spoke arrival whether to carry spoke→center consolidation freight. If this decision reads from a shared mutable structure (`pendingByCenter`) without proper initialization (one entry per spoke, not per trailer), two trailers from the same spoke arriving simultaneously will both drain the same queue and the second will get an empty manifest — without raising an error.

**How to avoid:**
Model bidirectional freight as two independent queues: `pendingBySpoke` (unchanged, center→spoke) and `pendingAtSpoke` (new, spoke→center consolidation). The `pendingAtSpoke` map is keyed by `spokeHubId`, and the return leg drains it just as the outbound drains `pendingBySpoke`. Induction at a spoke creates packages in `pendingAtSpoke`; the return leg carries them to the center. Empty return is not an error — the return leg departs with `packageIds: []` which is valid. Verify: the existing `TrailerDeparted` schema does not enforce `packageIds.length > 0` (check `trailerDepartedSchema` in `schemas.ts`). Add an explicit test: a spoke with no consolidation freight produces a valid `TrailerDeparted` with empty `packageIds` on the return leg. Add a test: two trailers from the same spoke drain `pendingAtSpoke` independently (no double-drain).

**Warning signs:**
- Return-leg `TrailerDeparted` events disappear from the event stream when `pendingAtSpoke` is empty.
- Two trailers from the same spoke both show `packageIds: []` even though consolidation freight exists (double-drain).
- The optimizer's twin snapshot shows a spoke trailer "docked" indefinitely with no pending departure (starvation: no consolidation freight, no return dispatch scheduled).

**Phase to address:** Phase 3 (bidirectional freight) — the two-queue model and empty-return tests are phase 3 success criteria.

---

### P9 — Bidirectional flow double-counting freight at consolidation

**What goes wrong:**
When a spoke→center consolidation trailer arrives at the center, the center's `hub_inventory.inbound` receives the consolidation packages. If those packages are also in `hub_inventory.staged` (because an earlier optimizer plan had staged them for a center→spoke trip that was never dispatched — a stale plan), the packages appear twice in the inventory count. KPI utilization (already a package-count proxy, not true volume fill — known tech debt) inflates. The optimizer's `buildTwinSnapshot` sees doubled freight volume for those packages and produces an over-allocated load plan.

**Why it happens:**
The `hub-inventory` reducer is additive on `PackageArrivedAtHub` (increments `inbound` count) and subtractive on `PackageScanned { scanType: "load" }` (removes from `staged`). If a package is first put in `staged` by an optimizer plan that never fires a `PackageScanned.load` (because the optimizer was re-run and the plan was superseded), then the package arrives via consolidation and is added to `inbound`, it exists simultaneously in `staged` (stale plan) and `inbound` (fresh arrival). The reducer's `staged` list is populated by a planner event (`PlanAccepted`), not by a sim event, so there is no automatic clean-up when a plan is superseded.

**How to avoid:**
Ensure `PlanAccepted` handling in the hub-inventory reducer is supersession-aware: when a new plan is accepted for a hub, the old plan's `staged` entries for packages not in the new plan must be removed. This is the event-sourced "plan supersession" event — a `PlanSuperseded` event that the optimizer emits before `PlanAccepted`. Alternatively, the `staged` list must only contain packages for which an active (non-superseded) plan exists; the reducer must handle `PlanSuperseded`. Add a Vitest test: emit `PlanAccepted` for package P1, then emit a second `PlanAccepted` that does NOT include P1; assert `staged` no longer contains P1.

**Warning signs:**
- `hub_inventory.staged` contains package ids that also appear in `hub_inventory.inbound`.
- KPI utilization jumps to > 100% at consolidation hubs.
- The optimizer load plan assigns a package that is already aboard a different trailer in transit.

**Phase to address:** Phase 3 (bidirectional freight) — plan supersession semantics must be resolved before spoke→center consolidation is activated.

---

### P10 — Outbound terminal-state ambiguity: freight that never reaches "delivered out"

**What goes wrong:**
Today's terminal state is `PackageArrivedAtHub`. For v2.0, outbound delivery introduces a new terminal state: `PackageDeliveredOut` (freight leaving a destination hub for the last-mile handoff). If the outbound handoff is modeled as a probability (e.g., packages have a `deliveryWindow` and are handed off if the window has elapsed), packages whose window has not elapsed by the time the finite-ish demo runs will remain in `package_location` with no terminal event — accumulating in projections. Separately, if `PackageDeliveredOut` is the correct terminal but the outbound simulation logic uses `PackageArrivedAtHub` as the trigger for scheduling a handoff, and the spoke's `arriveTrailer` does not fire `PackageArrivedAtHub` before scheduling the handoff, the handoff may be scheduled before the package is logically at the hub — a sequencing error in the event queue.

**Why it happens:**
The existing `arriveTrailer` function emits `PackageScanned.unload` then `PackageArrivedAtHub` for each delivered package. Outbound delivery must fire AFTER `PackageArrivedAtHub`, not concurrently. If outbound is scheduled from within `arriveTrailer` before the `PackageArrivedAtHub` events are emitted, the event-queue ordering ensures it fires at a later tick — but if it is emitted (not scheduled) within the same callback, it will appear in the stream before `PackageArrivedAtHub` for the same tick, which violates the lifecycle ordering that projections depend on.

**How to avoid:**
(1) Model outbound handoff as a scheduled event, not an inline emit: after emitting `PackageArrivedAtHub`, call `schedule(arriveTick + outboundDwellTicks, () => emitDeliveredOut(packageId, hubId))`. This guarantees `PackageArrivedAtHub` always precedes `PackageDeliveredOut` in the event stream. (2) Add a Zod schema and TS interface for `PackageDeliveredOut` (following the existing pattern). (3) Define the terminal lifecycle: `PackageArrivedAtHub` → (outbound dwell) → `PackageDeliveredOut`. A package that reaches `PackageDeliveredOut` must be removed from `package_location`, `hub_inventory`, and `zone_estimate`. (4) Add a golden test: for every package created in an outbound-enabled run, assert it eventually emits `PackageDeliveredOut` within the sim horizon.

**Warning signs:**
- Packages accumulate in `package_location` with `lastSeenAt` at the spoke but no `PackageDeliveredOut`.
- `PackageDeliveredOut` appears before `PackageArrivedAtHub` for the same package.
- The hub detail panel shows packages as "at hub" for packages that were handed off for last-mile delivery.

**Phase to address:** Phase 2 (outbound delivery modeling) — the terminal event and lifecycle ordering tests are phase 2 success criteria.

---

### P11 — In-memory idempotency loss on process restart (existing tech debt, worsened by continuous operation)

**What goes wrong:**
The optimizer's `(epoch, scopeHash)` idempotency is stored in an in-memory Map in `rolling-service.ts` (known tech debt from v1.0 audit). In a finite run that completes before the process restarts, this is tolerable. In a continuous open-ended run the process may restart (OOM, deploy, crash). On restart the in-memory idempotency map is empty. The optimizer re-runs every prior epoch's inputs against the current twin state. If the twin state has changed since those epochs were first run (due to intervening events), the re-run produces different plans and emits duplicate `PlanGenerated` / `PlanAccepted` events. For an open-ended run this can produce hundreds of duplicate plan events in the minutes after restart, flooding the audit timeline.

**Why it happens:**
The in-memory idempotency was explicitly documented as "sufficient for single-process MVP demo" (v1.0 audit). A finite demo does not restart mid-run. An indefinite demo eventually does.

**How to avoid:**
Persist idempotency keys to a Postgres table `optimizer_idempotency (epoch_id TEXT, scope_hash TEXT, result JSONB, created_at TIMESTAMPTZ, PRIMARY KEY (epoch_id, scope_hash))`. Before running an epoch, check whether `(epoch_id, scope_hash)` already exists; if so, return the cached result directly without re-running. On process start, the table survives the restart and the optimizer does not re-run stale epochs. The table can be pruned of entries older than 24 sim-hours to prevent unbounded growth. This also fixes the LRU memory concern from P7.

**Warning signs:**
- After a process restart, the audit timeline shows a burst of `PlanGenerated` events with timestamps from before the restart.
- Multiple `PlanAccepted` events for the same `(epochId, trailerIds)` in the event log.
- Optimizer worker RSS grows beyond 512MB in a run exceeding 2 hours.

**Phase to address:** Phase 3 (bidirectional freight + optimizer durability) — implement persistent idempotency before the first open-ended production demo.

---

### P12 — WebSocket backpressure and client memory growth over sustained runs

**What goes wrong:**
The ws keyframe+delta protocol (`envelope.ts`) sends one `TickPayload` per tick with all changed entities. In a finite 120-tick run, the client receives ~120 tick messages and the heap stays bounded. In a continuous run at the demo's sim speed (120× compression, ~1 tick/500ms wall clock), the client receives ~7,200 tick messages per hour. The `diffTick` computation (`envelope.ts`) builds a new diff object per tick. If the client's map of `TrailerKeyframe` or `HubState` grows (new trailers, new hubs) but never shrinks, the ws snapshot object size grows over time. At 1,000 ticks, the WS send queue on the server can back up if a client is slow (tab backgrounded, phone CPU throttled). Node's `ws` library does not automatically drop stale messages — it buffers them, growing the per-socket send queue until the process OOMs or the client reconnects.

**Why it happens:**
The existing ws backpressure handling assumes a finite run where the client always keeps up. In an indefinite run a briefly-backgrounded browser tab can fall arbitrarily far behind. The snapshot on reconnect (`buildSnapshot`) already handles resync, but the send-queue accumulation before the client drops and reconnects is unbounded.

**How to avoid:**
(1) Add a per-socket send-queue depth check before each `broadcast`: if `ws.bufferedAmount > BACKPRESSURE_THRESHOLD` (e.g., 256KB), skip this tick's delta for that client. The client's seq-gap detection will trigger a resync on the next message received. This is already the documented pattern in the ws protocol (`useWsEnvelope` seq-gap → resync). (2) Set a reasonable `ws.OPEN` socket timeout: if a socket has not sent a ping response in 30 seconds, terminate it and rely on client reconnect. (3) Cap the snapshot payload: the `SnapshotPayload` must not include ALL trailers and packages ever created — only currently active ones (those with status != terminal). Reuse the active-filter from P5 here. (4) Add a soak test: connect a ws client, run the sim for 1,000 ticks, assert ws send queue depth stays bounded and client heap does not exceed 200MB.

**Warning signs:**
- `ws.bufferedAmount` grows without bound during a long run.
- A backgrounded browser tab causes the Node process to buffer > 100MB of unsent frames.
- Client heap grows linearly with sim runtime (never GC'd trailer/hub map entries).
- The `SnapshotPayload` sent on reconnect after 2 hours includes 10,000 packages.

**Phase to address:** Phase 1 (continuous operation) — backpressure and resync handling are prerequisites for any open-ended run.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems in a continuous-operation context.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Single `pendingBySpoke` map for all freight (center-origin only) | Simple, works for v1 | Cannot represent spoke→center consolidation freight or induction-at-spoke freight without ambiguity | Never in v2.0 — must be replaced with `pendingBySpoke` + `pendingAtSpoke` + `inductionQueue` maps |
| In-memory `(epoch,scopeHash)` idempotency Map | No DB dependency in optimizer | Unbounded memory growth in continuous run; lost on restart → duplicate plans | Acceptable only if a max-entries LRU eviction is added in Phase 1 |
| No projection watermarks (full `readAll` from seq=0 on rebuild) | No schema complexity | O(log-size) rebuild cost grows with run duration; prohibitive after hours | Acceptable for finite demo; must be fixed in Phase 1 |
| Utilization = package count proxy (not true volume fill) | Simple KPI | Misleads optimizer on bidirectional loads: a trailer full of small consolidation packages shows "100% utilization" while a large outbound block is left staged | Acceptable through Phase 2; fix with weight+volume-based utilization in Phase 3 |
| Detection scans ALL packages in `zone_estimate` every tick | No filtering complexity | O(packages-ever-inducted) per tick; becomes prohibitive after continuous induction | Must scope to active-only in Phase 2 hardening |

---

## Integration Pitfalls

Mistakes specific to how the new v2.0 features integrate across system boundaries.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Induction → event store | Emitting `FreightInducted` as a raw sim event but forgetting to add it to `domainEventSchema` discriminated union | Every new event type has a Zod schema added and tested through `validate()` before the first sim run |
| Outbound delivery → optimizer twin | Adding `PackageDeliveredOut` as a terminal event but not removing the package from `TwinSnapshot.blocks` | The twin builder must filter out terminal-state packages; add a test asserting delivered packages are absent from twin input |
| Bidirectional flow → VRPTW | Passing `fromHubId = spoke, toHubId = center` to `routeTrailers` without adding the reverse leg to `TravelModel` | `buildTravelModel` already inserts both directions (`leg.set(A→B)` and `leg.set(B→A)`); verify the reverse-leg coverage includes spoke→center routes |
| Bidirectional flow → freeze window | Spoke→center return departures not registering a `departureMin` in the twin snapshot | The freeze-window `isFrozen` predicate reads `departureMin` from the twin; return trips must stamp their departure time in the snapshot exactly as outbound trips do |
| Continuous operation → ws snapshot | `buildSnapshot` reading `readAll` from global seq 0 on every new client connection | `buildSnapshot` must read from Postgres projection tables, not the raw event log; audit every call site in `snapshots.ts` |

---

## Performance Traps

Patterns that work at the current 120-tick scale but fail at thousands of ticks.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| `readAll(db, 0n)` in hot path | Rebuild latency grows linearly with log size | Projection watermarks: `readAll(db, lastProcessedSeq)` | > 1,000 events in log (~10 ticks of induction at scale) |
| Detection over all `zone_estimate` rows | Per-tick detection time grows without bound | Filter to `is_active = true` packages; index on `is_active` | > 500 active packages (detection already flagged as scaling concern in v1.0 audit) |
| `diffTick` building full current-state snapshot every tick | WS send payload grows with hub/trailer count | `diffTick` already diffs — verify it only sends changed entities; add a test asserting a no-change tick sends `{}` | > 100 trailers in continuous fleet |
| `scopeHash` canonicalize over full twin snapshot | Hashing cost grows with snapshot size | Scope the hash to only the affected sub-snapshot (the `scope` slice, not the full twin) | > 200 active freight blocks in twin |
| In-memory `availableAtMinByDriver` Map growing with all drivers ever registered | Memory leak in continuous long runs | Evict drivers whose `availableAtMin` is > 48h in the past (they will never relay again) | > 1,000 drivers registered across a long run with fleet scaling |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces specific to v2.0 additions.

- [ ] **Continuous operation:** `nextDepart <= durationTicks` guard removed from `arriveTrailer` — but the queue still terminates when empty. Verify there is always a future event scheduled (e.g., next induction batch) so the queue never goes empty mid-run.
- [ ] **External induction:** `FreightInducted` event emitted by sim — but verify it is also added to `domainEventSchema`, tested through `validate()`, and handled by every relevant projection reducer.
- [ ] **Outbound delivery:** `PackageDeliveredOut` terminal event emitted — but verify `package_location`, `hub_inventory`, and `zone_estimate` reducers REMOVE the row on this event (not just record it).
- [ ] **Bidirectional freight:** Spoke→center `TrailerDeparted` emitted — but verify `trailerStateReducer` handles it identically to center→spoke (same state machine), the optimizer VRPTW `TravelModel` has the reverse leg, and the hub detail panel shows the trailer's bidirectional status correctly.
- [ ] **Salt collision test:** New induction/outbound/consolidation RNG salts added — but verify the pairwise-distinct assertion in the existing salt-collision test was extended to cover all new salts.
- [ ] **Projection watermarks:** Catch-up projections updated with checkpoint persistence — but verify `runCatchup` reads from the watermark, not from `0n`, after restart.
- [ ] **WS backpressure:** `bufferedAmount` check added — but verify the `seq`-gap resync path is exercised by the new check (a skipped tick produces a seq gap, the client requests resync, the snapshot reflects terminal-cleaned state).
- [ ] **Optimizer idempotency persistence:** `optimizer_idempotency` table migration added — but verify the migration runs before the first continuous demo and that the table is pruned on startup.

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| P1 — Induction RNG substream perturbs existing streams | Phase 1: continuous + induction foundation | Salt-collision assertion extended; `determinism.unit.test.ts` golden stays green with `inductionEnabled: true` feature-off |
| P2 — Non-deterministic event ordering at same tick | Phase 1: continuous + induction foundation | New bidirectional/induction `schedule()` calls all use `queue.claimSeq()`; no `for...of Map` without sort |
| P3 — Float accumulation drift over long runs | Phase 1: continuous operation | `simulate({ seed:42, durationTicks:10000 })` golden hash matches across Node 22 x86 and ARM in CI |
| P4 — Unbounded event-log growth and replay cost | Phase 1: continuous operation | `projection_checkpoints` table exists; `runCatchup` reads from watermark; snapshot connect-time < 500ms at 10k events |
| P5 — Projection state explosion, unbounded packages | Phase 2: outbound delivery | `PackageDeliveredOut` removes rows from `package_location`/`hub_inventory`/`zone_estimate`; detection runtime flat at 1000+ packages |
| P6 — Golden-replay drift from new event types | Every phase introducing new events | `validate(event)` round-trip test for every new event type; integration test confirms event store row count = `out.length` |
| P7 — Optimizer thrash under continuous arrivals | Phase 3: bidirectional + optimizer awareness | Induction at SFO does not re-scope trailers at BOS; worker RSS stays < 512MB at 2h run |
| P8 — Empty-return assumption / spoke starvation | Phase 3: bidirectional freight | Empty-manifest return `TrailerDeparted` accepted; two trailers from same spoke drain `pendingAtSpoke` independently |
| P9 — Double-counting freight at consolidation | Phase 3: bidirectional freight | `PlanSuperseded` clears stale `staged` entries; `hub_inventory.staged ∩ hub_inventory.inbound = ∅` at all times |
| P10 — Outbound terminal-state ambiguity | Phase 2: outbound delivery | `PackageDeliveredOut` always follows `PackageArrivedAtHub` in stream; no package remains active after delivered-out |
| P11 — In-memory idempotency loss on restart | Phase 3 (or earlier LRU fix in Phase 1) | Process restart during run produces no duplicate `PlanAccepted` events; `optimizer_idempotency` table persists across restart |
| P12 — WS backpressure / client memory growth | Phase 1: continuous operation | Backgrounded-tab soak test: 1000 ticks, send queue depth bounded; client heap < 200MB |

---

## Sources

- `packages/simulation/src/engine.ts` — RNG substream model (lines 63–93), `EventQueue` deterministic tie-break (lines 247–275), `generate()` structure (lines 283–1237). VERIFIED.
- `packages/simulation/src/rng.ts` — `makeRng` / `mulberry32` implementation. VERIFIED.
- `packages/optimizer/src/rolling/freeze-idempotency.ts` — `scopeHash`, `canonicalize`, `isFrozen`. VERIFIED.
- `packages/optimizer/src/rolling/epoch.ts` — `runEpoch` pipeline + `buildTravelModel` symmetric leg insertion. VERIFIED (first 80 lines).
- `packages/projections/src/reducers/package-location.ts` — additive-only upsert, no terminal-state removal. VERIFIED.
- `packages/projections/src/reducers/trailer-state.ts` — `TrailerStatus` ("in_transit" | "arrived" | "docked"), no terminal. VERIFIED.
- `packages/projections/src/detector.ts` — `runDetection` iterates all `readPlannedAssignments()` + `readObserved()` without active-package filter. VERIFIED.
- `packages/api/src/sim/driver.ts` — per-tick loop structure, `runCatchup`, `readAll` usage. VERIFIED (first 120 lines).
- `packages/api/src/ws/snapshots.ts` — `diffTick`, `buildSnapshot`, ws send path. VERIFIED (first 60 lines).
- `packages/api/src/sim/sim-controller.ts` — finite `durationTicks` anchor. VERIFIED.
- `packages/domain/src/events/schemas.ts` — `.strict()` discriminated union, `packageArrivedAtHubSchema` as current terminal. VERIFIED.
- `.planning/PROJECT.md` — v2.0 goals, known tech debt (in-memory idempotency, utilization proxy, detection cost scaling), v1.0/v1.1/v1.2 context. VERIFIED.
- `milestones/v1.0-MILESTONE-AUDIT.md` (referenced in PROJECT.md) — known debt items confirmed by audit: in-memory idempotency, utilization proxy, detection-cost-scales-with-state.

---
*Pitfalls research for: v2.0 Complete Simulation Model — continuous/open-ended operation, external induction, outbound delivery, bidirectional freight*
*Researched: 2026-06-23*
