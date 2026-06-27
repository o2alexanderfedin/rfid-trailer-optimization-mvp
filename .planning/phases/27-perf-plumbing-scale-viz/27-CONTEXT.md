# Phase 27: Perf + Plumbing + Scale Viz - Context

**Gathered:** 2026-06-26
**Status:** Ready for planning

<domain>
## Phase Boundary

A continental run (~80–130 hubs) renders cleanly and sustains a live demo without the freeze/stall
failure mode. Three independent workstreams plus two user-approved demo carry-overs:

- **PERF (read-side + plumbing):** `twin-snapshot` stops doing two full event-log scans per optimizer
  epoch (PERF-02, read-side only, **no golden change**); the vendored `@alexanderfedin/async-queue` is
  wired into **runtime plumbing only** and banned from the deterministic core (PERF-03); a sustained
  continental run holds a target sim-min/wall-sec (PERF-04).
- **VIZ (scale rendering):** 100+ hubs render without clutter via OpenLayers `Cluster` + `declutter` +
  `VectorImageLayer`; static topology stays sent-once; per-tick deltas carry only trailers + transient
  suggestions (VIZ-15); centers/spokes/backbone render as a distinct visual tier (VIZ-16); an opt-in
  accept-green/reject-red advisory-suggestion overlay (VIZ-17).
- **Demo carry-overs (user-approved this phase):**
  - **P27-A** — make the optimizer-backed reroute **genuinely route-aware-divergent** from the
    rule-based path (COORD-06 criterion-1). **Changes the optimizer-on golden** → capture a NEW one.
  - **P27-B** — tune the **continental demo scenario** so the headline "won't divert: HOS/fuel"
    reject (COORD-03) fires LIVE. **Demo-config-only → leaves baked goldens intact.**

In scope: PERF-02, PERF-03, PERF-04, VIZ-15, VIZ-16, VIZ-17 + P27-A + P27-B.
Out of scope: the consolidated determinism/golden audit (Phase 28); cross-center optimizer coordination;
operator-tunable guard constants (deferred to v3.1).

**Determinism keystone (unchanged):** flags-off stays byte-identical to `3920accc…`. PERF-02 is read-side
(no golden). P27-A captures a NEW optimizer-on golden reproducibility-first (flags-off `3920accc…` and
coordinator-on `edfa5a6d…` stay intact; the documented-equality assertion flips to documented-divergence).
P27-B changes only the continental demo config (not baked goldens). The new optimizer-on golden feeds the
Phase 28 consolidated audit.
</domain>

<decisions>
## Implementation Decisions (accepted in discuss — all four areas "accept all/both")

### Area 1 — PERF-02: incremental cursor-fold twin-snapshot (READ-SIDE ONLY, no golden)
- Replace the two `readAll(es, 0n)` full-log folds in `buildTwinSnapshot` —
  `computeMilesSinceRefuel` (`twin-snapshot.ts:100-113`) and `buildInductionDeadlines`
  (`twin-snapshot.ts:125-137`) — with bounded reads of two NEW incremental projections.
- New projections, folded by the existing incremental `applyInline` cursor (mirror the v2.1 key-scoped
  fold + the `catchup.ts` persisted-index precedent):
  - `trailer_fuel(trailer_id PK, miles_since_refuel)` from the existing pure `trailerFuelReducer`
    (`packages/projections/src/reducers/trailer-fuel.ts`). Its internal `routes` + `inflight` indices can
    **reuse** the already-persisted `geo_route` (directed-hub-pair geometry) and `geo_inflight_trip`
    (trip→leg) tables — so the new table may be as small as `(trailer_id, miles_since_refuel)`.
  - `induction_deadline(package_id PK, deadline_min)` — trivial last-write-wins from `PackageInducted`.
- Register each: pure reducer + key-scoped applier (in `APPLIERS`, `inline.ts:857`) + checkpoint name +
  `OPERATIONAL_PROJECTIONS` (`schema.ts:250`) + DDL in `PROJECTIONS_SCHEMA_SQL`/`schema.sql` + add to the
  `rebuild.ts` TRUNCATE list (`rebuild.ts:50`). The driver's existing per-tick fold
  (`sim/driver.ts ~495/712/1049`) picks them up automatically — no new fold loop.
- `buildTwinSnapshot` switches to `db.selectFrom("trailer_fuel"|"induction_deadline")...` bounded reads.
- **Correctness:** rebuild-equivalence test (incremental fold == full-scan reducer fold, byte-identical) —
  template from `packages/projections/test/hub-inventory-cost.unit.test.ts` (the T-23-04 rebuild-equivalence
  `it` + counting-fake cost-invariance) and `packages/api/test/projections-golden-replay.int.test.ts`
  (live==rebuilt via `serializeTwin`). Add both new tables to the rebuild/serialize surface.
- **No golden change:** `simulate()` (the event generator that the determinism goldens hash) has zero
  dependency on `buildTwinSnapshot`; `milesSinceRefuel`/`deadlineMin` are consumed only downstream in the
  optimizer epoch and produce a byte-identical result, so suggestions/plans are unchanged.

### Area 2 — PERF-03: async-queue runtime plumbing (banned from the core)
- **Vendor resolution:** the submodule ships only `src/` (`dist/` is gitignored, built via `tsc` → CJS).
  Build + link it: add `vendor/*` to `pnpm-workspace.yaml`, depend on `@alexanderfedin/async-queue`, and
  ensure `dist/` is produced (a `prepare`/build step so the workspace link resolves `dist/index.js` +
  `.d.ts`). The repo is ESM, the lib is CJS — verify resolution once linked.
- **Always parameterize** `AsyncQueue<ConcreteType>` (the lib defaults `<T = any>`; our `no-explicit-any`
  is enforced — `vendor/**` is ESLint-ignored so the lib itself isn't linted, but our call sites are).
- **Wire all three plumbing seams (bounded, O(1), FIFO):**
  - (a) worker↔optimizer handoff — bound the currently-**unbounded** `pending` Map / `postMessage`
    (`packages/api/src/optimizer/worker-client.ts:103`) with a small `AsyncQueue<WorkerRequest>` that
    backpressures the live-loop instead of growing in-flight epochs.
  - (b) DB write-batching — the per-event awaited INSERT loop (`packages/event-store/src/store.ts:111-124`)
    coalesces into multi-row `.values([...])` commits behind a bounded write queue.
  - (c) ws backpressure — replace the **drop-based** 256 KB skip (`snapshots.ts:691,718-725`) with a
    per-client bounded `AsyncQueue<string>` (broadcast enqueues at `snapshots.ts:905`; a per-socket
    consumer dequeues + awaits `socket.send` drain) → true bounded-memory backpressure.
- **ESLint core-ban:** extend the existing DET-03 `no-restricted-imports` block (today scoped to
  `ooda/**` + `coordinator/**`, `eslint.config.ts:103-225`; config already notes "widens engine-side in
  Phase 27" at :100-102) to the **full simulation deterministic core** (`packages/simulation/src/**`,
  honoring existing test exclusions). `vendor/**` stays in ignores.
- **Order guarantee:** an `append-order == generation-order` test in OUR suite (enqueue N
  monotonically-tagged items through a real handoff; assert dequeue order == enqueue order). The queue
  must never reorder the event stream.

### Area 3 — VIZ-15/16/17: scale visualization (greenfield rendering on the existing map)
- **Declutter (VIZ-15):** swap the hub (and, where it helps, trailer) `VectorLayer` to
  `ol/source/Cluster` + `declutter: true` on a `VectorImageLayer`. (None exist today — all layers are
  plain `VectorLayer`, `packages/web/src/map/layers.ts`.)
- **Protocol:** the "topology sent once" half is **already met** — hubs/routes geometry is fetched via
  REST on map init (`MapView.tsx:267`), never over ws; the ws `tick` payload carries only id-keyed metric
  buckets. Keep that. Add a tick-only `suggestions?` field to `TickPayload` (`envelope.ts:222`), mirroring
  `inductionEvents` (transient, never on snapshot) — per-tick payload stays bounded as hub count grows.
- **Tiers (VIZ-16):** propagate the Phase-23 topology distinction to the client — add `kind`/`tier` to the
  hub DTO (`GET /hubs`, `app.ts:26-34` / `HubDto`) and `isBackbone` to the route DTO (`queries.ts:64`),
  sourced from `network/centers.ts` (`isCenter`) + the backbone leg set. Style three distinct tiers:
  centers (large) / spokes (small) / backbone legs (heavy) vs spoke legs (light) — extend the cached
  per-bucket style fns (`coloring.ts`).
- **Suggestion overlay (VIZ-17):** opt-in toggle; accept=green / reject=red; decluttered. Clone the
  AlertFeed pipeline: new `useSuggestions` hook (mirror `useAlertFeed`, `AlertFeed.tsx:136`), dispatch in
  `onAlertEnvelope` (`App.tsx:56`), render a `SuggestionFeed` in `RightRail.tsx:92` AND/OR a map overlay
  layer (`createSuggestionLayer` mirroring the induction/delivery flash layers, `layers.ts:249/288`).

### Area 4 — Demo carry-overs P27-A + P27-B (both accepted this phase)
- **P27-A (optimizer-divergent reroute, COORD-06 criterion-1) — CHANGES the optimizer-on golden.**
  Root cause of today's byte-identical endorsement = 3 structural pins in `optimizerRerouteFor`
  (`packages/simulation/src/engine.ts ~2410-2531`): (1) route head pinned to `obs.centerId`
  (`:2481-2484`); (2) always-actionable `departureOffsetMin = FREEZE+1` (`:2476`); (3) no real load/capacity
  (`blocks:[]`, constant capacity 50, only center↔hub legs). Fix:
  - Give the optimizer a **real destination choice** — build the per-center twin with multiple candidate
    relief legs (the center AND alternate uncongested cross-dock hubs from the partitioned slice); read the
    optimizer's actually-chosen next hub from the routed `EpochResult` (not the static `route[0]`)
    in `epochResultToRerouteSuggestions` (`coordinator/optimize.ts:193-197`).
  - Encode **real freeze/feasibility** — derive `departureOffsetMin` from the trailer's real scheduled
    departure (near-departure ⇒ genuinely frozen, left untouched); populate real `blocks` + per-leg
    `capacity`/`travelMin`/`distanceMiles` from fold state so the optimizer can **decline** an infeasible
    reroute (over-capacity / LIFO-blocked) and recommend a different/better one.
  - Files: `engine.ts optimizerRerouteFor`; `coordinator/optimize.ts buildCenterTwinFromFold` +
    `epochResultToRerouteSuggestions`. `runEpoch` itself is unchanged.
  - **Golden:** capture a NEW optimizer-on golden **reproducibility-first** (in-process twice + 2 separate
    node processes, per the 25-05 protocol). Flip `coordinator-optimizer-determinism.unit.test.ts` from
    "EQUALS `edfa5a6d`" to "DIFFERS from `edfa5a6d` AND `3920accc`/`94689f99`". `3920accc` (flags-off) and
    `edfa5a6d` (rule-based coordinator-on) stay intact. The new golden flows into the Phase-28 audit.
- **P27-B (live reject-with-reason, COORD-03) — DEMO-CONFIG-ONLY, no baked golden change.**
  Why dead today: the reroute rule is queue-depth-only / HOS-fuel-blind (`coordinator/observe.ts:46-53`,
  `coordinator.ts:84-96`); a reject only fires when a rerouted truck is coincidentally HOS/fuel-out; fuel
  is OFF by default (`domain/src/fuel.ts:47-53`); HOS limits are generous. Simplest deterministic fix
  (**option 1, chosen** — avoids touching `3920accc`/`edfa5a6d`): in the **continental demo config** only,
  enable fuel + lower `refuelThresholdMiles` (and/or tighten `maxDriveMin`) so a long backbone leg
  deterministically pushes a mid-trip truck past the refuel/HOS limit exactly when it's behind a congested
  hub the reroute rule already targets → the "won't divert: HOS/fuel" reject fires live. Reject is already
  rendered: `AlertFeed.tsx:202` ← `COORDINATION_REJECT_LABELS` (`exceptions.ts:54-61`) ←
  `SuggestionRejected` → `coordination-rejected` row (`exceptions.ts:242-257`) → wire `blockedFreight`
  (`snapshots.ts:416-431`). Do NOT take the targeting-heuristic path (option 2) — it would move
  coordinator/optimizer goldens.

### Claude's Discretion
- Exact projection table/column names + whether to reuse vs add the trailer-fuel internal-index tables;
  the async-queue `maxSize` per seam; the precise tier color/size scale + cluster distance + declutter
  thresholds; the suggestion-overlay interaction details; the exact continental demo-config numbers for
  P27-B (deterministic, no clock/RNG); the per-center candidate-relief-leg selection for P27-A — all at
  Claude's discretion following existing patterns, subject to the golden constraints above.
</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- **PERF-02:** `packages/projections/src/runner/inline.ts` (key-scoped fold + `APPLIERS` registry +
  checkpoints), `runner/catchup.ts` (persisted-index incremental precedent — `geo_route`/`geo_inflight_trip`),
  `reducers/trailer-fuel.ts` (pure reducer to persist), `schema.ts` (tables/registry/DDL), `runner/rebuild.ts`
  (`serializeTwin`), `sim/driver.ts` (existing incremental cursor fold), `twin-snapshot.ts` (the two scans).
  Test templates: `projections/test/hub-inventory-cost.unit.test.ts`, `api/test/projection-fold-bounded.int.test.ts`,
  `api/test/projections-golden-replay.int.test.ts`.
- **PERF-03:** `vendor/async-queue` (`AsyncQueue<T>(maxSize)` — enqueue/dequeue blocking, O(1) circular
  buffer FIFO), `eslint.config.ts:103-225` (DET-03 ban block to widen), `worker-client.ts:103`,
  `event-store/src/store.ts:111-124`, `ws/snapshots.ts:691,718-725,904-905`.
- **VIZ:** `web/src/map/{MapView.tsx,layers.ts,coloring.ts}` (OL map + plain VectorLayers + cached styles),
  `api/src/ws/envelope.ts` (snapshot/tick union, `TickPayload`, `diffTick`), `web/src/panels/AlertFeed.tsx`
  + `RightRail.tsx` + `App.tsx` (the feed pipeline to clone for suggestions), `network/centers.ts`
  (center/backbone source), DTOs in `domain/src/entities/index.ts` + `api` `app.ts`/`queries.ts`.
- **P27-A/P27-B:** `engine.ts optimizerRerouteFor`, `coordinator/optimize.ts`, `coordinator/observe.ts`,
  `coordinator.ts`, `coordinator/handshake.ts`+`feasibility.ts`, `domain/src/{fuel,hos}.ts`,
  `coordinator-optimizer-determinism.unit.test.ts`, `continental-determinism.unit.test.ts`,
  `projections/src/reducers/exceptions.ts`.

### Established Patterns
- Incremental key-scoped projection fold with per-projection checkpoint (v2.1); pure reducers; rebuild ==
  live byte-identical via `serializeTwin`. Flag-gated features; reproducibility-first golden capture;
  two-part flags-off gate. ESLint `no-restricted-imports` for the deterministic-core import ban.
- ws: REST-once topology + id-keyed metric-bucket tick deltas; transient tick-only event arrays
  (`inductionEvents`/`deliveryEvents`) for flashes. Cached per-bucket OL styles (zero-alloc).

### Integration Points
- New operational projections join the `applyInline`/`rebuild`/`serializeTwin` surface (additive, like
  `driver_status.hos_clock` was). async-queue slots into 3 named seams (worker post, event-store insert,
  ws broadcast). New `kind`/`isBackbone` DTO fields + tick-only `suggestions?` field. New optimizer-on
  golden constant feeds Phase 28.
</code_context>

<specifics>
## Specific Ideas
- **Suggested plan grouping for the planner** (sequence respecting the golden constraints):
  1. PERF-02 incremental cursor-fold (read-side, no golden) — independent, safe first.
  2. PERF-03 vendor build/link + workspace + ESLint core-ban + 3 plumbing seams + order test.
  3. P27-A optimizer-divergent reroute → NEW optimizer-on golden (reproducibility-first).
  4. P27-B continental demo-config reject tuning (live HOS/fuel reject) + VIZ-17 suggestion overlay.
  5. VIZ-15/16 declutter + tiers (Cluster/declutter/VectorImageLayer + DTO tier fields).
  6. PERF-04 sustained continental-run validation (demonstrable live end-to-end).
- **Bookkeeping fix (do this phase):** `REQUIREMENTS.md` traceability mismarks OODA-02, OODA-03, COORD-04,
  COORD-05 as "Pending" — they are verified COMPLETE (24/25-VERIFICATION.md). Flip them to Complete (+ tick
  the requirement checkboxes). COORD-03 stays Pending until P27-B makes it fire live (then mark Complete).
- The continental run is tested for short-run *difference* (`continental-determinism.unit.test.ts` seed-42/300),
  not a frozen hash — so P27-B's demo-config tuning needs no baked-golden recapture.

## Deferred Ideas
- Consolidated determinism/golden audit (agent-order-shuffle, N-agent-RNG-decorrelation, continuation-
  equivalence, master flags-off) → Phase 28 (DET-02).
- Cross-center / network-wide optimizer-driven coordination; operator-tunable guard constants → v3.1.
- Tightening the route/departed bounded queries in twin-snapshot (not in the PERF-02 criterion) → optional.
</specifics>

<deferred>
## Deferred Ideas
See <specifics> "Deferred Ideas" — Phase 28 (consolidated DET-02 audit) and v3.1 (cross-center
coordination, operator-tunable guard constants).
</deferred>
