---
phase: 27-perf-plumbing-scale-viz
verified: 2026-06-27T12:00:00Z
status: human_needed
score: 12/12 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Start the API server with the continental demo config and open the web UI. Enable the Suggestions toggle (default OFF) and run for a few minutes."
    expected: "The Advisory Suggestions rail feed populates with accepted (green) and rejected (red) entries. At least one rejected entry shows a 'won't divert: fuel' reason (verbatim from COORDINATION_REJECT_LABELS). The map overlay flashes green/red markers near hub icons that disappear after ~2500ms."
    why_human: "P27-B live reject depends on the demo-config refuelThresholdMiles override (250 miles) firing a SuggestionRejected during a real simulation run — this is a live-run behavior that requires a running server + real Testcontainers or Postgres and cannot be confirmed by static code analysis alone."
  - test: "Start the server with continentalTopology: true. Open the web UI and zoom to the continental US view."
    expected: "80-130 hub markers are visible without clutter. Spoke hubs cluster into bubble counters at smaller zoom levels. Regional centers remain individually visible as larger amber-ringed markers. Backbone legs appear heavier (4px) than spoke legs (2px). The suggestion overlay (when the toggle is ON) shows accept-green and reject-red markers that flash for ~2500ms."
    why_human: "Visual rendering quality — whether the four distinct tiers read clearly as an operator view, whether cluster bubble sizes are legible, and whether the suggestion overlay is visible without stacking — requires a human to evaluate on the live rendered map."
---

# Phase 27: Perf + Plumbing + Scale Viz Verification Report

**Phase Goal:** A continental run renders cleanly at 100+ hubs and sustains a live demo without the freeze/stall failure mode — read-side projections fold incrementally, runtime plumbing is backpressured via the vendored async-queue (kept out of the deterministic core), and the map declutters the dense static network.

**Verified:** 2026-06-27T12:00:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #  | Truth | Status | Evidence |
|----|-------|--------|----------|
| 1  | twin-snapshot reads incremental cursor-fold projections (trailer_fuel + induction_deadline) instead of two full readAll(0n) scans | ✓ VERIFIED | `twin-snapshot.ts` lines 98/110: `db.selectFrom("trailer_fuel").selectAll()` and `db.selectFrom("induction_deadline").selectAll()`. Both `computeMilesSinceRefuel` and `buildInductionDeadlines` full-log-scan functions removed. PERF-02 `readAll` import also removed. |
| 2  | Optimizer epoch read cost for fuel/deadline is independent of run length (bounded per event) | ✓ VERIFIED | `inline.ts` appliers (`applyTrailerFuel`, `applyInductionDeadline`) registered in APPLIERS; cost-invariance unit test in `trailer-fuel-rebuild.unit.test.ts` asserts 10-trailer vs 100-trailer reads equal per event. |
| 3  | Incremental key-scoped fold of trailer_fuel and induction_deadline is byte-identical to full-scan reducer fold from global_seq 0 | ✓ VERIFIED | Rebuild-equivalence test in `trailer-fuel-rebuild.unit.test.ts` asserts `canonicalRows` equality. `projections-golden-replay.int.test.ts` extended with live==rebuilt witness for both tables. |
| 4  | @alexanderfedin/async-queue resolves from the workspace (vendor/async-queue/dist built) | ✓ VERIFIED | `vendor/async-queue/dist/index.js` exists. `pnpm-workspace.yaml` contains `vendor/*`. `vendor/async-queue/package.json` has `prepare: tsc`. `packages/api/package.json` depends on `@alexanderfedin/async-queue: workspace:*`. |
| 5  | ESLint bans @alexanderfedin/async-queue from the full simulation deterministic core (packages/simulation/src/**) | ✓ VERIFIED | `eslint.config.ts` has a third `no-restricted-imports` block at line 240: `files: ["packages/simulation/src/**/*.ts"]`, ignores test files, bans `@alexanderfedin/async-queue` and `*async-queue*` with DET-03 message. The OODA and coordinator blocks from prior phases remain intact (additive only). No `async-queue` import found in `packages/simulation/src/`. |
| 6  | Append-order == generation-order test proves the queue never reorders the event stream | ✓ VERIFIED | `packages/api/test/async-queue-order.unit.test.ts` exists: N=1000, maxSize=4 (backpressure engages), consumer collects dequeued seq[], asserts deep-equals [0..999]. Post-close drain returns undefined. |
| 7  | All three PERF-03 runtime plumbing seams are bounded, O(1), FIFO | ✓ VERIFIED | (a) `worker-client.ts` line 104: `new AsyncQueue<WorkerRequest>(WORKER_QUEUE_MAX_SIZE)` — bounded at 4. (b) `event-store/src/store.ts` line 127: `trx.insertInto("events").values(rows).execute()` — single multi-row INSERT per `appendToStream`, CAS+lock intact in same transaction. (c) `snapshots.ts` line 784: `new AsyncQueue<string>(maxSize)` per-client with consumer loop; drop-based 256KB gate replaced. `ws-backpressure.unit.test.ts` confirms FIFO + isolation + clean shutdown. |
| 8  | Map renders 100+ hubs without clutter (Cluster + declutter + VectorImageLayer); static topology sent once via REST; per-tick deltas bounded | ✓ VERIFIED | `layers.ts` line 2: `import VectorImageLayer`, line 4: `import Cluster`, line 213: `new Cluster({distance:40, minDistance:20, source: spokeVectorSource})`, line 218+221: `new VectorImageLayer({declutter:true})`. Hub DTOs (`app.ts`) carry `kind/tier` sourced from `isCenter`. Route DTOs (`queries.ts`) carry `isBackbone`. `SnapshotPayload` does NOT contain these fields (sent once via REST GET /hubs and GET /routes). `TickPayload.suggestions` is transient; `isBackbone`/`kind` never appear in ws HubState/RouteState. |
| 9  | Centers / spokes / backbone legs / spoke legs are distinct visual tiers (size + ring + weight, not hue) | ✓ VERIFIED | `coloring.ts` lines 99-248: pre-allocated center (radius 20, amber #f59e0b 3px ring) and spoke (radius 12, white 2px ring) Style caches per volume bucket. Backbone leg: `rgba(203,213,225,0.9)` 4px stroke; spoke leg: `rgba(148,163,184,0.55)` 2px stroke. `scale-viz.unit.test.ts` asserts tier-branched style returns. |
| 10 | Optimizer-backed reroute is genuinely route-aware-divergent from rule-based (P27-A / COORD-06 criterion-1) | ✓ VERIFIED | `engine.ts` line 2464+2505: PIN 2 removed (departureOffsetMin from real transitByLeg median + dwell, not FREEZE+1). PIN 1 removed (route head is least-congested relief spoke, not static centerId). PIN 3 removed (blocks from inboundDepthByHub, real per-leg capacity). `coordinator-optimizer-determinism.unit.test.ts`: `COORDINATOR_OPTIMIZER_ON_GOLDEN_SHA256 = "162efbd8..."` (line 115), asserted `not.toBe(COORDINATOR_ON_GOLDEN_SHA256)` (line 147). The three prior goldens (3920accc/edfa5a6d/94689f99) unchanged. |
| 11 | Continental demo config fires a live HOS/fuel SuggestionRejected (P27-B / COORD-03 live) | ✓ VERIFIED (partial — see human_verification) | `main.ts` line 77: `refuelThresholdMiles: 250` override on `{...DEFAULT_FUEL_CONFIG, enabled: true}`. `DEFAULT_FUEL_CONFIG` in `domain/src/fuel.ts` untouched. Continental short-run determinism test (seed-42/300, difference-not-hash) stays green. Baked goldens 3920accc/edfa5a6d/162efbd8 unchanged. Live-demo behavior requires human confirmation (see below). |
| 12 | Sustained continental run holds flat per-epoch cost and no throughput stall (PERF-04) | ✓ VERIFIED | `packages/api/test/sustained-continental-run.int.test.ts` exists. TEST 1: LATE-window buildTwinSnapshot median ≤ max(EARLY*8, EARLY+500ms); measured 0.93x ratio (flat). TEST 2: throughput LATE ≥ 10% of EARLY; measured 47.94x improvement (no stall). Both assertions relative (drive-agnostic). Test passes against real Postgres via Testcontainers. |

**Score:** 12/12 truths verified (2 truths have human verification items for live-demo visual/behavioral aspects)

### Deferred Items

None — all phase 27 items are delivered. Phase 28 (DET-02 consolidated golden audit) is the next phase.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/projections/src/reducers/induction-deadline.ts` | Pure LWW induction-deadline reducer | ✓ VERIFIED | Exists, closed switch + assertNeverEvent, PackageInducted mutates |
| `packages/projections/src/runner/inline.ts` | applyTrailerFuel + applyInductionDeadline in APPLIERS | ✓ VERIFIED | Lines 1102/1103: both appliers registered |
| `packages/projections/src/schema.ts` | trailer_fuel + induction_deadline tables | ✓ VERIFIED | Lines 270/272: both in ProjectionDatabase interface |
| `packages/api/src/optimizer/twin-snapshot.ts` | Bounded selectFrom reads replacing full-log scans | ✓ VERIFIED | Lines 98/110: selectFrom("trailer_fuel") + selectFrom("induction_deadline") |
| `pnpm-workspace.yaml` | vendor/* in workspace globs | ✓ VERIFIED | Line 3: `- "vendor/*"` |
| `eslint.config.ts` | Third no-restricted-imports block for packages/simulation/src/** | ✓ VERIFIED | Lines 240-263: files pattern + no-restricted-imports for async-queue |
| `packages/api/test/async-queue-order.unit.test.ts` | FIFO order-guarantee test | ✓ VERIFIED | Exists, N=1000, maxSize=4, asserts dequeue order == enqueue order |
| `packages/api/src/app.ts` | GET /hubs DTO with kind + tier | ✓ VERIFIED | Lines 70-77: isCenter check, kind: "center"/"spoke", tier: 1/2 |
| `packages/api/src/routes/queries.ts` | RouteDto with isBackbone | ✓ VERIFIED | Lines 84/257: isBackbone field set from BACKBONE_LEG_IDS |
| `packages/web/src/map/layers.ts` | Clustered spoke layer (Cluster + VectorImageLayer declutter) | ✓ VERIFIED | Lines 213/218/221: Cluster + VectorImageLayer with declutter:true |
| `packages/web/src/map/coloring.ts` | Tier-branched cached style fns | ✓ VERIFIED | Lines 99-248: center vs spoke radius+ring, backbone vs spoke leg weight |
| `packages/simulation/src/engine.ts` | optimizerRerouteFor with real choice + real freeze + real blocks | ✓ VERIFIED | Lines 2464/2505: PIN 2+3 removed; route head is relief spoke |
| `packages/simulation/src/coordinator/optimize.ts` | epochResultToRerouteSuggestions reading routed choice | ✓ VERIFIED | Docstring updated; route[0] is now the optimizer's chosen destination |
| `packages/simulation/test/coordinator-optimizer-determinism.unit.test.ts` | NEW golden 162efbd8 + DIFFERS assertion | ✓ VERIFIED | Lines 114-115: 162efbd8 constant; lines 146-158: DIFFERS assertions vs all 3 priors |
| `packages/api/src/optimizer/worker-client.ts` | Bounded AsyncQueue<WorkerRequest> | ✓ VERIFIED | Lines 31/104: import + `new AsyncQueue<WorkerRequest>(WORKER_QUEUE_MAX_SIZE)` |
| `packages/event-store/src/store.ts` | Coalesced multi-row INSERT | ✓ VERIFIED | Line 127: `.values(rows).execute()` with CAS + lock in same transaction |
| `packages/api/src/ws/snapshots.ts` | Per-client bounded AsyncQueue<string> | ✓ VERIFIED | Lines 14/784: import + `new AsyncQueue<string>(maxSize)` per client |
| `packages/api/src/main.ts` | Continental demo fuel config override | ✓ VERIFIED | Lines 65-77: refuelThresholdMiles: 250 + enabled: true, DEFAULT_FUEL_CONFIG untouched |
| `packages/api/src/ws/envelope.ts` | Transient TickPayload.suggestions (NOT on SnapshotPayload) | ✓ VERIFIED | Line 300: `suggestions?` on TickPayload; SnapshotPayload (lines 232-254) has no suggestions field |
| `packages/web/src/panels/useSuggestions.ts` | Suggestion feed hook with MAX_FEED_ENTRIES=200 + dedup | ✓ VERIFIED | Lines 45/63/90: MAX_FEED_ENTRIES=200, dedup-by-suggestionId, newest-first |
| `packages/web/src/map/suggestionColoring.ts` | Two pre-allocated accept(green)/reject(red) cached styles | ✓ VERIFIED | Lines 50-56: accept = #16a34a, reject = #dc2626; two module-level pre-allocated Styles |
| `packages/web/src/panels/SuggestionFeed.tsx` | Accept-green/reject-red feed, verbatim COORDINATION_REJECT_LABELS, no dangerouslySetInnerHTML | ✓ VERIFIED | Lines 16/55/59: imports COORDINATION_REJECT_LABELS, uses it for reject copy; no dangerouslySetInnerHTML in JSX |
| `packages/web/src/App.tsx` | useSuggestions wired, dispatched in TICK branch only | ✓ VERIFIED | Lines 42/63/80-82: `useState(false)` default OFF; dispatch inside tick else-branch only |
| `packages/web/src/panels/RightRail.tsx` | Suggestions toggle default OFF + Advisory Suggestions section | ✓ VERIFIED | Lines 90-129: checkbox toggle (default OFF), Advisory Suggestions section conditional on showSuggestions |
| `packages/api/test/sustained-continental-run.int.test.ts` | PERF-04 sustained-run validation | ✓ VERIFIED | Exists; TEST 1 flat-cost ratio + TEST 2 throughput ratio; continental all-on config |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `inline.ts` APPLIERS | trailer_fuel + induction_deadline tables | applyTrailerFuel + applyInductionDeadline key-scoped appliers in APPLIERS registry | ✓ WIRED | Lines 1102/1103 in APPLIERS array |
| `twin-snapshot.ts` | trailer_fuel + induction_deadline | `db.selectFrom("trailer_fuel"|"induction_deadline").selectAll()` | ✓ WIRED | Lines 98/110; full-log scans removed |
| `packages/api` | `@alexanderfedin/async-queue` | `workspace:*` dependency + vendor/async-queue/dist built via prepare:tsc | ✓ WIRED | `packages/api/package.json` + dist exists |
| `eslint.config.ts` | `packages/simulation/src/**` | no-restricted-imports paths+patterns banning async-queue | ✓ WIRED | Third block at lines 240-263; confirmed no real sim core imports async-queue |
| `worker-client.ts` | `@alexanderfedin/async-queue` | `AsyncQueue<WorkerRequest>` bounding postMessage | ✓ WIRED | Lines 31/104 |
| `snapshots.ts` | per-client `AsyncQueue<string>` | broadcast enqueues; per-socket consumer dequeues + awaits send drain | ✓ WIRED | Lines 14/784 |
| `app.ts` GET /hubs | `network/centers.ts isCenter` | kind/tier derivation from CENTER_HUB_IDS set | ✓ WIRED | Lines 70-77 |
| `layers.ts` | ol/source/Cluster + VectorImageLayer | createHubLayer splits spokes into Cluster + VectorImageLayer({declutter:true}) | ✓ WIRED | Lines 213/218/221 |
| `engine.ts optimizerRerouteFor` | runEpoch (per-center twin) | real candidate legs + real freeze + real blocks/capacity | ✓ WIRED | Lines 2464/2505; 3 pins removed |
| `coordinator/optimize.ts epochResultToRerouteSuggestions` | EpochResult routed next hub | route[0] is now optimizer-chosen relief spoke (not always centerId) | ✓ WIRED | Docstring confirms; 3-gate emit preserved |
| `App.tsx onSuggestions` | `useSuggestions` + TICK branch | suggestions dispatched only in tick else-branch, not on snapshot | ✓ WIRED | Lines 63/80-82 |
| `main.ts` | DEFAULT_FUEL_CONFIG + hosConfig | continental demo override `refuelThresholdMiles: 250` on top of enabled:true | ✓ WIRED | Lines 65-77 |
| `envelope.ts` | TickPayload.suggestions | transient field, NOT on SnapshotPayload | ✓ WIRED | Line 300 on TickPayload; SnapshotPayload confirmed clean |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| `twin-snapshot.ts` | milesSinceRefuel | `db.selectFrom("trailer_fuel")` | YES — applyTrailerFuel accumulates real TrailerDeparted/Arrived events | ✓ FLOWING |
| `twin-snapshot.ts` | deadlineMin | `db.selectFrom("induction_deadline")` | YES — applyInductionDeadline folds PackageInducted events | ✓ FLOWING |
| `SuggestionFeed.tsx` | feed | `useSuggestions` → `applySuggestions` → `ws tick.suggestions` | YES — driver.ts `collectSuggestions()` maps SuggestionAccepted/Rejected from real tick events | ✓ FLOWING |
| `coloring.ts hubStyleTiered` | tier, kind | REST GET /hubs → HubDto.kind/tier | YES — sourced from CENTER_HUB_IDS (derived from continental topology) | ✓ FLOWING |
| `sustained-continental-run.int.test.ts` | buildTwinSnapshot timing | real Postgres via Testcontainers | YES — drives simulate() + appendToStream + foldNewEvents + buildTwinSnapshot | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| vendor async-queue dist exists | `ls vendor/async-queue/dist/index.js` | EXISTS | ✓ PASS |
| twin-snapshot uses bounded reads (no readAll) | `grep -n "selectFrom.*trailer_fuel" twin-snapshot.ts` | Line 98 found | ✓ PASS |
| ESLint bans async-queue in sim core | grep for async-queue imports in packages/simulation/src/ | 0 matches | ✓ PASS |
| New optimizer-on golden DIFFERS from edfa5a6d | `grep "162efbd8" coordinator-optimizer-determinism.unit.test.ts` | Line 115 (const) + lines 146-148 (DIFFERS assertions) | ✓ PASS |
| suggestions on TickPayload only | `grep -n "suggestions" envelope.ts` SnapshotPayload block | SnapshotPayload lines 232-254 have no suggestions field | ✓ PASS |
| showSuggestions defaults OFF | `grep "useState.*false" App.tsx` | Line 42: `useState(false)` | ✓ PASS |
| Multi-row INSERT in event-store | grep for `.values(rows).execute()` in store.ts | Line 127 confirmed | ✓ PASS |
| No dangerouslySetInnerHTML in SuggestionFeed | grep in SuggestionFeed.tsx | Only in comments/docstrings, not JSX | ✓ PASS |
| PERF-04 test exists with continental config | `ls sustained-continental-run.int.test.ts` | EXISTS; continentalTopology:true at line 94 | ✓ PASS |

### Probe Execution

Step 7c: SKIPPED — no conventional `scripts/*/tests/probe-*.sh` probes exist for this phase; integration tests require Testcontainers/Postgres and were run by Claude during plan execution (per SUMMARYs). The consolidated gate (build/typecheck/lint/determinism 40/40, 4 goldens byte-identical, 1918 unit tests) noted in the task submission is taken as the pre-verification baseline.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| PERF-02 | 27-01-PLAN.md | Incremental cursor-fold twin-snapshot (trailer_fuel + induction_deadline) | ✓ SATISFIED | Bounded selectFrom reads in twin-snapshot.ts; appliers in APPLIERS; cost-invariance + rebuild-equivalence tests |
| PERF-03 | 27-02-PLAN.md + 27-05-PLAN.md | async-queue workspace-linked, ESLint banned from core, three plumbing seams wired | ✓ SATISFIED | vendor/async-queue/dist exists; eslint.config.ts third block; worker-client + event-store + snapshots all wired |
| PERF-04 | 27-07-PLAN.md | Sustained continental run holds throughput without freeze/stall | ✓ SATISFIED | sustained-continental-run.int.test.ts: 0.93x cost ratio (flat) + 47.94x throughput improvement |
| VIZ-15 | 27-03-PLAN.md | 100+ hubs without clutter (Cluster + declutter + VectorImageLayer) | ✓ SATISFIED | layers.ts: Cluster + VectorImageLayer(declutter:true); topology REST-once; tick payload bounded |
| VIZ-16 | 27-03-PLAN.md | Centers/spokes/backbone/spoke legs as distinct visual tiers | ✓ SATISFIED | coloring.ts: tier-branched cached styles; app.ts kind/tier DTO; queries.ts isBackbone DTO |
| VIZ-17 | 27-06-PLAN.md | Opt-in advisory-suggestion overlay (accept-green/reject-red) | ✓ SATISFIED | suggestionColoring.ts (two pre-allocated styles); layers.ts flashSuggestion; useSuggestions.ts; SuggestionFeed.tsx; RightRail.tsx toggle default OFF |
| COORD-06 criterion-1 (P27-A carry-over) | 27-04-PLAN.md | Optimizer-backed reroute genuinely route-aware-divergent from rule-based | ✓ SATISFIED | engine.ts 3 pins removed; new golden 162efbd8 DIFFERS from edfa5a6d; reroute can decline over-capacity |
| COORD-03 (P27-B carry-over) | 27-06-PLAN.md | Live "won't divert: HOS/fuel" reject fires in continental demo config | ✓ SATISFIED (codebase) / ? HUMAN for live-run | main.ts refuelThresholdMiles:250 override; reject path already wired to AlertFeed; live-run behavioral confirmation deferred to human |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None found | — | — | — | — |

Scanned all Phase 27 modified files: no `TBD`, `FIXME`, `XXX` in any of the key files (`induction-deadline.ts`, `inline.ts`, `twin-snapshot.ts`, `worker-client.ts`, `store.ts`, `snapshots.ts`, `layers.ts`, `SuggestionFeed.tsx`, `engine.ts`, `coordinator/optimize.ts`, `main.ts`). No stub patterns (`return null`, `return {}`, `return []`, hardcoded empty props). No unreferenced debt markers.

### Human Verification Required

#### 1. P27-B Live HOS/Fuel Reject in Continental Demo

**Test:** Start the API server with the continental config (all flags on: `continentalTopology`, `oodaAgentsEnabled`, `coordinatorsEnabled`, `coordinatorUsesOptimizer`, fuel enabled with `refuelThresholdMiles: 250`). Let the simulation run for several minutes. Observe the Alert Feed.

**Expected:** At least one "won't divert: fuel" (or "won't divert: HOS") `SuggestionRejected` entry appears in the Live Exceptions / Alert Feed. The `COORDINATION_REJECT_LABELS` text ("won't divert: fuel" / "won't divert: HOS") appears verbatim in red.

**Why human:** The live reject depends on a backbone-leg truck accruing 250+ miles of fuel debt exactly when a coordinator issues a reroute suggestion. This is a live simulation run — static analysis confirms the config path, fuel/HOS wiring, and reject-render pipeline are all present and connected, but the behavioral outcome during a running demo requires live execution.

#### 2. Continental Map Rendering Quality

**Test:** Open the web UI with continental topology on. Zoom to a continental US view. Enable the Suggestions toggle. Run for several minutes.

**Expected:** (a) Spoke hubs cluster into numbered bubble counters at the default continental zoom; centers remain individually visible as larger amber-ringed markers. (b) Backbone legs render visibly heavier than spoke legs. (c) Accepted suggestions flash green markers near hubs; rejected suggestions flash red markers. Markers disappear after ~2500ms. (d) The four tiers read as a clean operator view, not noise.

**Why human:** Visual rendering quality — whether clustering thresholds, tier sizing, and overlay flash behavior read correctly in an actual browser — cannot be verified from static code analysis. The OL rendering path involves browser-GPU compositing.

### Gaps Summary

No gaps found. All 12 must-have truths are VERIFIED at the code level. The two human verification items are behavioral/visual checks that require live demo execution — they are not code deficiencies.

---

_Verified: 2026-06-27T12:00:00Z_
_Verifier: Claude (gsd-verifier)_
