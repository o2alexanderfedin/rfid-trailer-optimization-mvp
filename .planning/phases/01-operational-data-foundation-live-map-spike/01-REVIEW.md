---
phase: 1
slug: operational-data-foundation-live-map-spike
reviewed: 2026-06-19
confirmed_high: 0
confirmed_medium: 6
confirmed_low: 10
total_confirmed: 16
---

# Phase 1 — Code Review

> Adversarially-verified findings for the Operational Data Foundation + Live Map Spike. Every issue
> below was confirmed against the actual source (file:line cited) — initial HIGH claims were
> down-rated where no shipped Phase-1 path triggers them. **0 HIGH · 6 MEDIUM · 10 LOW.**
>
> No finding blocks the Phase-1 gate. The MEDIUM issues are real, bounded, and **future-triggerable**
> (chiefly when Phase 4 / a background poller adds a concurrent writer). The LOW issues are carried
> debt for later phases.

---

## Severity Summary

| Severity | Count | Disposition |
|----------|-------|-------------|
| HIGH | 0 | — |
| MEDIUM | 6 | Fix before Phase 4 concurrent-writer paths or any non-public deploy |
| LOW | 10 | Carried debt — schedule into later phases |

---

## MEDIUM (6) — real, latent, future-triggerable

### M-1 · event-store · `readAll(fromGlobalSeq)` high-water cursor can permanently skip events under concurrent appends (identity gap)
**File:** `packages/event-store/src/store.ts:253-264` (readAll) · `schema.sql:23` (`global_seq` identity) · `appendToStream` `store.ts:77`
**Kind:** determinism

**Evidence.** `readAll` filters `global_seq > fromGlobalSeq`. `global_seq` is `BIGINT GENERATED ALWAYS
AS IDENTITY` — allocated at INSERT, visible only at COMMIT. `appendToStream` uses a plain
`db.transaction()` with **no** isolation override / advisory lock / ordering guard (grep confirms zero
`SERIALIZABLE`/advisory/isolation anywhere). All consumers use a single high-water cursor
(`catchup.ts:155/215`, `inline.ts:254`, `rebuild.ts:64`, `driver.ts:108`). Under READ COMMITTED, two
appends to **different** streams don't contend on the CAS row, so identity-allocation order can differ
from commit order — the classic in-flight-gap precondition. So the cursor design **is** gap-unsafe in
principle.

**Why MEDIUM not HIGH.** No shipped Phase-1 reader ever overlaps an in-flight append: the production
driver (`driver.ts:91-118`) appends one-at-a-time in a **sequential await loop** and only then runs
`readAll`/`runCatchup`; the sim is the sole writer (`main.ts:26`, one sequential call); there is **no**
background poller (grep: no `setInterval`/worker/cron). The one place with genuinely concurrent
cross-stream appends, `drives-projections.int.test.ts:71-85`, runs `readAll(es, 0n)` strictly **after**
`await Promise.all(...)` resolves (after all commits). The original finding also mischaracterized
`concurrency.int.test.ts:55-59`, which races two appends on the **same** stream (CAS contention) and
does no `readAll`/catch-up at all. Net: latent design fragility, real Phase-4 footgun, but no Phase-1
path triggers it today.

**Fix.** Make `readAll`'s cursor safe against in-flight gaps before any concurrent-writer-during-
catch-up path lands. Preferred: gate visibility with a low-water mark so `readAll` only returns rows
below the oldest still-in-flight txid (filter via `pg_snapshot_xmin(pg_current_snapshot())` / a
per-row `txid_current()` column, or read at REPEATABLE READ bounded by the snapshot xmin).
Alternatives: (a) serialize log appends (single append connection or table-level advisory lock around
the IDENTITY insert) so identity order == commit order; (b) replace the single high-water seq with a
gap-tracking cursor that re-checks holes below max. **Minimum now:** document on `readAll(fromGlobalSeq)`
that it is only safe when appends are strictly serialized (the current Phase-1 guarantee), and add a
cross-stream concurrent-append-WHILE-reading regression test so the assumption is enforced before
Phase 4 adds a second writer.

---

### M-2 · event-store · Concurrent different-stream appends → commit order ≠ `global_seq` order (total order is allocation order, not commit order)
**File:** `packages/event-store/src/store.ts` (appendToStream `:77`, readAll `:261`) · `schema.ts:98` (`global_seq` identity) · consumers `catchup.ts:149-157`, `inline.ts:254`
**Kind:** concurrency

**Evidence.** `global_seq` identity is allocated at INSERT but the row is visible only at COMMIT, so
under concurrent writers in separate transactions commit/visibility order can differ from `global_seq`
order, producing temporary gaps. Consumers assume "seen K ⟹ seen everything < K": `catchup.ts:149-157`
and `runGeoTrack` do `from=checkpoint; events=readAll(db, from); advanceCheckpoint(stored.globalSeq)`
per event; `inline.ts:254` gates on `replay.globalSeq <= lastSeq`. If a poller's `readAll` runs while
seq=6 is committed but seq=5 is still in-flight, it advances the checkpoint past 6 and **permanently**
skips 5 (next read is strictly > 6). Untested under concurrency: `concurrency.int.test.ts` only races
same-stream appends; `append-read.int.test.ts:107-131` awaits sequentially.

**Why MEDIUM not HIGH.** `ARCHITECTURE.md:131` explicitly scopes this tradeoff ("global ordering via
identity column is gap-tolerant… never assume contiguity. For multi-writer-per-stream you'd need
advisory locks — not needed at MVP"), and the only current invocation (`driver.ts → main.ts`) is
strictly sequential — every `appendToStream` is awaited before `readAll`/`applyInline`/`runCatchup`,
with no background poller wired and no overlapping commits, so the bug cannot fire in shipped Phase-1
code. It is MEDIUM not LOW because the module advertises+tests concurrent-writer support, `schema.ts:117`
documents catch-up as "a background poller", and Phase 4 adds the optimizer as a documented concurrent
writer (`concurrency.int.test.ts` docstring + `01-03-PLAN.md`). The moment that poller/optimizer runs
concurrently with writers against these `readAll`/checkpoint consumers, a committed event is silently
and permanently dropped from a catch-up projection (e.g. the audit timeline) — undetected data loss in
a system whose stated purpose (FND-08, §9.1) is auditability. Within a single stream, gaps are
impossible (version CAS serializes the stream); the exposure is the cross-stream poller-skip.

**Fix.** Increasing robustness: (1) cheapest/sanctioned — keep `readAll` consumers
(inline/catchup) on the same single-threaded path as appends (as `driver.ts` already is) and document
that catch-up must NOT run as a truly-concurrent background poller against live appends without a guard
below; serialize append-then-project. (2) Gap-aware low-water read — do not advance the checkpoint past
any seq that could still have an uncommitted lower neighbor; compute a safe low-water mark, read with a
small lag / re-scan a trailing window, and only advance to the highest **contiguous** applied seq
(stop at the first gap, retry next tick). (3) Strongest — `pg_advisory_xact_lock` around the append
insert so allocation order == commit order. Independently, **add an integration test** issuing two
truly-concurrent `appendToStream` calls to two **different** streams (both commit) and assert an
incremental `readAll`+checkpoint consumer applies BOTH with no skip — ideally forcing the adverse
interleaving (hold one tx open at insert while the other commits first).

---

### M-3 · projections · Hub inventory removal-on-move depends on per-package load scans; `TrailerDeparted.packageIds` is ignored → departure without explicit `load` scans over-counts source-hub inventory
**File:** `packages/projections/src/reducers/hub-inventory.ts:174-177` (departure/arrival/dock no-ops), `:140-142` (`bucketForScan` load→null) · `packages/domain/src/events/schemas.ts:85-94` (`packageIds` required)
**Kind:** correctness

**Evidence.** `hubInventoryReducer` treats `TrailerDeparted`/`TrailerArrivedAtHub`/`TrailerDocked` as
no-ops (`return state;`). Source-hub inventory is decremented **only** via a separate
`PackageScanned{scanType:"load"}`, which `bucketForScan` maps to `null` so `placePackage` removes it.
`TrailerDeparted.packageIds` — a **required** authoritative manifest in the schema (`schemas.ts:85-94`,
`packageIds: z.array(id)`) — is ignored. Empirically reproduced with a vitest reducer test (2 passed):
a `TrailerDeparted` carrying `packageIds=['P1']` **after** an `outbound` scan but **without** a `load`
scan leaves `P1` permanently in `MEM.outbound` (`s.hubs.get('MEM').outbound === ['P1']`); the canonical
path **with** a load scan correctly empties it. Since `outbound` documents "staged at the dock, about
to depart", a package that has physically left lingering there is a real read-model correctness
violation that over-counts source-hub inventory (FND-07). No cross-event invariant guards it —
`validateEvent` is pure per-event zod validation with no ordering/manifest reconciliation.

**Why MEDIUM not HIGH.** The sole current producer (`packages/simulation/src/engine.ts:217-227`) emits
a `load` scan per package before every `TrailerDeparted`, so the shipped/tested path is correct and no
data is corrupted today. The defect is a latent correctness/resilience gap that activates if any future
producer emits `TrailerDeparted` without per-package load scans — a path the redundant payload manifest
actively invites.

**Fix.** Make the manifest the single source of truth: handle `TrailerDeparted` in
`hubInventoryReducer` by iterating `event.payload.packageIds` and calling `placePackage(state, id, null)`
for each, mirroring the existing `load`-scan removal. The per-package load scan then becomes
defensive/redundant rather than load-bearing. Add a reducer unit test asserting a `TrailerDeparted`
with `packageIds=['P1']` after an outbound scan leaves `MEM.outbound` empty. Optionally add a
projection-level invariant check that every departed packageId is absent from the `fromHub` buckets
after the event.

---

### M-4 · api-ws · Geo-arrival keyframe resolved by lexicographic leg-key guess, not the trailer's actual leg → mis-resolves when a hub has 2+ inbound legs
**File:** `packages/projections/src/reducers/geo-track.ts:158-168` (`arrivalPoint`) · `schemas.ts:96-103` (`TrailerArrivedAtHub` carries `tripId`), `:85-94` (`TrailerDeparted` carries `fromHubId`/`toHubId`/`tripId`) · `simulation/src/network/routes.ts:92-114` (buildRoutes)
**Kind:** correctness

**Evidence.** `arrivalPoint` resolves the arrival keyframe by iterating ALL routes whose key ends in
`"->hubId"` and picking the **lexicographically smallest** key's last vertex
(`if (best === null || key < best.key) best = {key, point}`), ignoring the trip's true leg — even
though `TrailerArrivedAtHub` carries `tripId` and the preceding `TrailerDeparted` carried
`fromHubId`/`toHubId`/`tripId`. So when a hub has 2+ inbound legs with distinct terminal vertices, the
projected "arrive" point is the wrong leg's endpoint. The trigger topology already exists: `buildRoutes`
makes the center hub (`hubs[0]=MEM`) the destination of every spoke→center leg (K distinct inbound legs
/ K distinct keys).

**Why MEDIUM not HIGH.** Harmless **only** because (a) `greatCircle` returns endpoints exactly
(`routes.ts:55-61`), so all inbound legs to a hub currently coincide at the hub coordinate, and (b) the
sim engine (`engine.ts:246-289`) only emits `TrailerArrivedAtHub` at `spoke.hubId` — each spoke is the
destination of exactly one leg — so the buggy multi-inbound branch never fires today. The bug is
deterministic across live vs rebuild (`catchup.ts:194-219` uses the same `arrivalPoint`), so the
rebuild-equivalence test (`audit-geo.int.test.ts:237-252`) cannot catch it, and the geo keyframe test
(`:216-235`) only seeds single-inbound DFW. Real but latent, bounded; the data model needed to fix it
is already present and discarded, and one engine change to project a center-hub arrival would mis-plot
the trailer.

**Fix.** Resolve the arrival leg from the trip, not by lexicographic guess. Add an in-flight trip→leg
map to `GeoTrackState`: on `TrailerDeparted` record `tripId → legKey(fromHubId,toHubId)`; on
`TrailerArrivedAtHub` look up that trip's leg geometry, take its last vertex, then delete the entry.
Persist this map alongside `geo_route` (e.g. a `geo_inflight_trip` table seeded in `loadRouteIndex`) so
incremental catch-up resolves identically to a full rebuild and stays deterministic. Delete
`arrivalPoint`; add a regression test: legs `AAA->ZZZ` and `BBB->ZZZ` with distinct terminal vertices,
depart `BBB->ZZZ`, assert the arrive keyframe lands on the `BBB->ZZZ` endpoint.

---

### M-5 · api-ws · Unhandled promise rejection on ws connect can crash the process (no `.catch` on `buildSnapshot`)
**File:** `packages/api/src/ws/snapshots.ts:105` · `buildSnapshot` `:59` · `queries.ts:191` (`readHubsFromLog`) · `catchup.ts:288` (`readGeoKeyframes`) · `main.ts:33`
**Kind:** concurrency (reliability)

**Evidence.** The `/ws` connect handler does
`void buildSnapshot(db).then((snap) => sendIfOpen(socket, snap));` with **no `.catch()`** and the `void`
operator explicitly discarding the promise. `buildSnapshot` awaits
`Promise.all([readGeoKeyframes(...), readHubsFromLog(...)])`; both are real async DB reads that can
reject on a transient pool error, DB restart, or network blip. The only `.then()` branch handles
fulfillment, so a rejection is unhandled. `main().catch()` (`main.ts:33`) does **not** cover it — it
wraps only the synchronous bootstrap chain that resolves when `app.listen` returns; the per-connection
`/ws` callback fires independently later. Grep across `packages/` source (excluding `dist`/`node_modules`)
found **no** process-level `unhandledRejection`/`uncaughtException` handler. `engines.node` is `>=22`
(running v23.11.0); since Node 15 the default `--unhandled-rejections` mode is `throw`, which with no
handler terminates the process with a non-zero exit. So a single ill-timed ws connect coinciding with a
DB hiccup can crash the entire API/ws server (availability/DoS). The broadcast path (`:110-115`) is
awaited inside the sim driver loop, so its rejection surfaces to the awaiter.

**Why MEDIUM not HIGH.** Corrupts no data and is not deterministically attacker-triggerable in
isolation — it requires a DB read to reject at the exact moment a client connects (a real but
conditionally-windowed reliability defect, not a guaranteed break). The ws integration test
(`packages/api/test/ws.int.test.ts`) only exercises the happy path and never simulates a rejecting DB
read, so it does not refute the finding.

**Fix.** Attach a rejection handler to the fire-and-forget connect-path promise at `snapshots.ts:105`,
e.g. `buildSnapshot(db).then((snap) => sendIfOpen(socket, snap)).catch((err) => { app.log.error(err,
"initial snapshot failed"); socket.close(); });` (`app` is in scope as the FastifyInstance param).
Closing the socket on failure lets the client reconnect cleanly. Defense-in-depth: register a
process-level `process.on('unhandledRejection', …)` in `main.ts`.

---

### M-6 · web-ol · Leak-guard e2e never exercises StrictMode double-mount; "created exactly once" unverified in dev, where it matters
**File:** `packages/web/test/leak.e2e.ts:131-132` (and `map.e2e.ts:123,133`) · `packages/web/src/main.tsx:11-15` (`<StrictMode>`) · `playwright.config.ts:22` (build+preview = prod bundle) · `MapView.tsx:65` (create-once guard), `:125-126` (cleanup), `:51/53/69/84` (counters)
**Kind:** correctness (test-coverage / invariant gap)

**Evidence.** `main.tsx` wraps `<App/>` in `<StrictMode>`. `playwright.config.ts:22` runs
`pnpm build && pnpm preview` — the **production** React bundle, where StrictMode's intentional
mount→cleanup→remount effect double-invocation is a no-op. The e2e asserts
`data-map-instances="1"` / `data-trailer-source-instances="1"`. But `MapView.tsx` cleanup
(`:125-126`) sets `mapRef.current = null` / `trailerSourceRef.current = null` while **not** resetting
the cumulative counters `mapInstancesRef`/`trailerSourceInstancesRef` (`:51,53,69,84`). Under dev
StrictMode: mount1 → guard passes (ref null) → counters=1; cleanup → ref=null; mount2 → guard passes
again → a second Map + second trailer `VectorSource` created → counters=**2**. So in `pnpm dev` the
diagnostics settle at 2, not 1. `vite.config.ts:15` explicitly documents `pnpm dev` (VIZ-01
human-verify) as a real, used path. There are NO jsdom/component tests (only the two e2e specs;
grep for StrictMode in tests returns nothing), so the double-mount is never exercised anywhere.

**Why MEDIUM not HIGH.** The cumulative-create count of 2 is a test-coverage / invariant-verification
gap, **not a live leak** — the first map IS properly disposed in cleanup (`map.setTarget(undefined)` +
`map.dispose()`, `:123-124`), so net-live instances remain 1. No runtime leak, data corruption, or
security impact. It is a real, bounded correctness gap in what the test *proves*.

**Fix.** Add a jsdom/RTL component test rendering `<StrictMode><MapView/></StrictMode>` that asserts
the intended invariant directly: across the dev double-mount the first `ol/Map` is disposed (spy on
`setTarget(undefined)`/`dispose`) before the second is created — i.e. net-live instances == 1. To make
`data-map-instances` literally read "1" even under StrictMode, gate creation on a ref **not** reset in
cleanup, or expose a separate "net live" attribute (`created - disposed`) and assert on that. Run the
leak guard at least once against a StrictMode-enabled (dev) build. Minimal change: introduce
`disposedCount`, assert `data-map-instances - disposedCount == 1`, and update the comment so it no
longer claims "created exactly once" when it means "exactly one live instance".

---

## LOW (10) — carried debt for later phases

### L-1 · web-ol · `data-trailer-uid` in-place-mutation probe is unsound — `getFeatures()[0]` order is not stable under spatial-index updates
**File:** `packages/web/src/map/MapView.tsx:142-145` · `leak.e2e.ts:110-111,136` · `layers.ts:87` (`useSpatialIndex: true`)
**Kind:** determinism (test correctness)

**Evidence.** `MapView.tsx` does `const probe = source.getFeatures()[0]; … setAttribute('data-trailer-
uid', getUid(probe))`; the e2e captures `earlyUid` then asserts it is unchanged as "in-place mutation
proof". But the trailer source is `new VectorSource({ useSpatialIndex: true })` with no features
collection, so `getFeatures()` returns `featuresRtree_.getAll()` = `rbush_.all()` in **tree-traversal**
order, not insertion order. Every `setCoordinates` fires a change → `featuresRtree_.update(...)` =
remove()+insert() when the bbox changes, reordering the tree. Empirically reproduced inside this repo's
`node_modules` (ol@10.9.0): 50 in-place-moved features with zero recreations → `getFeatures()[0]` uid
took 32 distinct values across 60 updates. The current 3-trailer lockstep fixture keeps index [0] stable
(1 distinct uid), so the test passes **today only by luck of the fixture**. The probe can report a
changed uid (fake leak / false failure) with no recreation, and a real recreation need not land at
index [0] (false negative). Only `data-trailer-count` is the reliable recreate guard.

**Why LOW.** Test-correctness/determinism defect — no production data or security impact. Bounded
because the load-bearing guards (bounded `data-trailer-count` + `getFeatureById`-based in-place upsert
in `updateTrailerFeatures`) are correct. But it gives false confidence in the in-place invariant and
becomes flaky the moment the fixture grows or positions diverge.

**Fix.** Replace the index-[0] probe with an id-based, order-independent probe:
`const probe = source.getFeatureById('trailer:T-1'); if (probe) containerRef.current?.setAttribute(
'data-trailer-uid', getUid(probe));`. `getFeatureById` reads the stable `idIndex_`; since
`updateTrailerFeatures` mutates that feature in place and never recreates it, the uid stays constant
unless that feature is recreated — a deterministic recreate detector regardless of rtree ordering.
Keep the bounded `data-trailer-count` assertion as the primary leak guard.

---

### L-2 · projections · Inline applier reloads AND rewrites the entire projection table on every event (O(N) read + O(N) write per event, O(M·N) over the log)
**File:** `packages/projections/src/runner/inline.ts` — `applyPackageLocation` (`:104` select, `:117` loop), `applyTrailerState` (`:141`, `:157`), `applyHubInventory` (`:187`, `:204`), `applyInline` `:252` · driver `api/src/sim/driver.ts:112` · `rebuild.ts:66`
**Kind:** performance

**Evidence.** Each operational applier does a full `selectFrom('<table>').selectAll().execute()` then
re-upserts the entire folded map. The pure reducers touch only 1–2 keys per event
(`package-location.ts` sets exactly one packageId; `hub-inventory.ts` `placePackage` touches at most
prior hub + target hub), so loading and rewriting every row is wasted O(N) work. `applyInline` runs all
three per event in the live path and in rebuild → O(M·N) over an M-event log with N accumulated rows;
`package_location`/audit grow unboundedly (one row per package ever seen). The contrast is real:
`catchup.ts:187-219` `runGeoTrack` seeds from persisted state and folds only post-checkpoint events,
documenting itself "O(new events), not O(log)".

**Why LOW.** Correctness, idempotency (P5a last_seq skip), and determinism (FND-04 byte-identical
rebuild) are all preserved — wasteful, not wrong. `.planning/REQUIREMENTS.md` defines **no**
latency/throughput/volume NFR, so nothing is broken at the simulated-demo scale this targets. Genuine,
provable scaling debt only.

**Fix.** Fold from the prior persisted state of only the affected key(s) and upsert only changed rows.
`package_location`: read just the touched `event.payload.packageId` row → fold → upsert that one row.
`trailer_state`: load only the affected `trailer_id`. `hub_inventory` is more involved (the reducer
reconstructs its `placement` index from all rows) — either persist a placement index table
(`package_id → hub_id+bucket`) and load only the touched package's placement plus its prior hub and
target hub rows, or add a `placement` column so only the prior + target hub rows are read/written. In
all three, diff old vs next and upsert only changed rows. Keep the identical-code-path-with-rebuild
(FND-04) invariant intact; re-run the golden-replay byte-equality tests after the change.

---

### L-3 · simulation · Route geometry uses transcendental Math, so "byte-identical on every platform" does not hold for `RouteRegistered` across engines / OS libm
**File:** `packages/simulation/src/network/routes.ts:19-31` (`toVec3`/`toLonLat`), `:48-72` (`greatCircle`) · `engine.ts:156-167` (geometry passed verbatim), `:22/:328`, `index.ts:4` (docstrings) · `rng.ts:8`
**Kind:** determinism (documentation/portability)

**Evidence.** `routes.ts` computes interior vertices via `Math.cos/sin/acos/asin/atan2`; the
full-precision irrational doubles flow verbatim into `RouteRegistered.payload.geometry` (`engine.ts`
`geometry: route.geometry`, no rounding). Reran the algorithm → non-truncated doubles like
`[-96.01383415840282, 38.53615023728523]`; the only `Math.round` in the package is `engine.ts:321` for
tick computation, not geometry. The RNG path is integer-only (`mulberry32` + `Math.imul`), so the
`rng.ts:8` "integer math only" claim is correct **for the RNG**, but the broader "byte-identical event
stream" docstrings implicitly cover geometry, which is not portable: IEEE-754 does not mandate
correctly-rounded transcendentals, so different libm/V8 builds can differ by a ULP.

**Why LOW.** Blast radius is purely latent: (1) NO checked-in golden snapshot files anywhere; (2)
`determinism.unit.test.ts` compares two `simulate()` runs in the SAME process (identical libm both
sides) — cannot flake cross-OS; (3) `golden-replay.int.test.ts` uses hand-built builders with NO
geometry/`RouteRegistered` events; (4) NO CI workflows, let alone a multi-OS matrix; (5) the real
persistence contract is log replay — geometry is generated once, persisted, then replayed from storage,
not regenerated, so replay determinism is immune. Manifests only in the hypothetical future where a
golden stream is generated on OS A and re-generated/verified on OS B. Inert documentation/portability
debt.

**Fix.** Cheapest/safest: quantize geometry coordinates before embedding in `RouteRegistered`, e.g.
`Number(v.toFixed(7))` (~1 cm, JSON-stable) in `buildRoutes`/`greatCircle` output or at the emit site
(`engine.ts:160-165`). Alternatively tighten the docstrings (`engine.ts:22/328`, `index.ts:4`) to scope
byte-identity to same-engine/same-platform OR to log-replay determinism, and avoid any cross-OS
golden-file comparison of raw `simulate()` output. Do NOT change the replay path — it reads stored
geometry and is unaffected.

---

### L-4 · simulation · Integration test's `Promise.all` concurrent append makes persisted `global_seq` order non-deterministic; safe today only because it skips geo-track and the exercised reducers are per-aggregate
**File:** `packages/simulation/test/drives-projections.int.test.ts:71-82,85,98-121` · `schema.ts:98` · `store.ts:77,261` · `geo-track.ts:84-117` · `catchup.ts:201-217` · `engine.ts:152,167,197-282`
**Kind:** determinism (test-only)

**Evidence.** `global_seq` is assigned at INSERT-commit; `appendToStream` wraps each call in its own
`db.transaction()`, so `await Promise.all(order.map(...))` runs N concurrent independent transactions
whose `global_seq` values interleave non-deterministically vs the simulator's emission order; `readAll`
orders strictly by `global_seq asc` and the test projects the whole log through it. Safe today: it
asserts only `packageLocation`/`trailerState`/`hubInventory` — all keyed per-aggregate (a package's
events live on `package-<id>`, a trailer's on `trailer-<id>`), and per-stream batched append preserves
per-stream version order regardless of cross-stream interleave; and it NEVER runs geo-track (only
`applyInline`). The geo-track cross-stream dependency is real (`geoTrackReducer` needs the route in
state from a prior `RouteRegistered`, on `route-<id>`, distinct from `trailer-<id>`), but the
RouteRegistered-before-Trailer invariant is already partly locked by `audit-geo.int.test.ts:129-145`
(sequential route seeding). Production (`driver.ts:91-104`) appends tick-by-tick sequentially and emits
all RouteRegistered at tick 0 before any departure.

**Why LOW.** Test-only latent debt — no production path affected, no data corruption, no requirement
broken.

**Fix.** Lowest-effort: a one-line comment at `:70-71` stating the concurrent `Promise.all` is
intentional and only valid because the asserted reducers are per-aggregate (cross-stream `global_seq`
order irrelevant), and that geo-track must NOT be asserted here without sequential persistence. If you
prefer determinism over the concurrency demonstration, replace `Promise.all` with a sequential
`for … await appendToStream(...)` loop over `order` so persisted `global_seq` mirrors emission order,
matching the production driver.

---

### L-5 · simulation · Per-stream batched append collapses every event's domain time to the first event's `occurredAt`, discarding the simulator's per-event virtual-clock timestamps
**File:** `packages/simulation/test/drives-projections.int.test.ts:74-80,27-29,93,98-121` · `store.ts:91` · `engine.ts:149,204,242,275-282` · `package-location.ts:72`, `geo-track.ts:105/124`, `inline.ts:95,116,124` · `driver.ts:58-69,97-103`
**Kind:** correctness (test-only)

**Evidence.** `appendToStream` writes its single `occurredAt` param to **every** event in the batch
loop (`store.ts:91`). The test passes the FIRST event's timestamp for a whole per-stream batch
(`new Date(buf[0]!.occurredAt)`). The simulator carries distinct per-event `occurredAt`
(`engine.ts:149 clock.nowIso()`) and a `package-<id>` stream spans ~30+ ticks (inbound at tick 0;
unload + arrival at `departTick + TRANSIT_TICKS(30)`), so the collapse discards real virtual-clock
times. Reducers persist `occurredAt` as domain time (`package-location.ts:72 lastSeenAt`,
`geo-track.ts:105/124 t`). The production driver AVOIDS the bug by grouping into ticks of one distinct
`occurredAt` then per stream within a tick (`driver.ts:58-69,97-103`), so each call legitimately shares
one timestamp.

**Why LOW.** Confined to ONE test's persistence path; production (`driveSimulation`) is correct, so no
real data is corrupted. The test asserts only counts and timestamp-independent structure
(`confidence===1`, `hubId.length>0`, trailer status), and asserts NO timestamp, so the collapse passes
silently — latent coverage gap, not an active failure. geo-track is not exercised here (only
`applyInline`). Grep confirms the buggy whole-stream batching exists only in this test file.

**Fix.** Reuse the production driver's grouping: group the buffered stream by distinct `occurredAt`
(one append per `(stream, tick)`) so every event in a call truly shares its timestamp. Minimal
alternative: keep per-stream batching but assert `loc.lastSeenAt` equals the package's true
terminal-sighting `occurredAt` so the collapse can't pass silently. Cleanest long-term: extend
`appendToStream` to accept a per-event `occurredAt` array. Also correct the header comment (`:27-29`)
which implies per-stream batching is fully equivalence-preserving — it preserves order but not
per-event domain time.

---

### L-6 · api-ws · geo-track silently drops a trailer's arrival keyframe when the leg's `RouteRegistered` has not yet been folded
**File:** `packages/projections/src/reducers/geo-track.ts:92-110` (departed), `:112-130` (arrived), `:96/117` (null returns), `:162-167` (`loadRouteIndex`) · `catchup.ts:194-219` (esp. `:215` unconditional checkpoint advance) · `engine.ts:152-168` (tick-0 bootstrap)
**Kind:** correctness (robustness)

**Evidence.** The `TrailerDeparted` case calls `endpoint()` and returns `{ state, keyframes: [] }` when
`point===null`; `TrailerArrivedAtHub` does the same via `arrivalPoint()`. Both null paths fire when the
leg's geometry is absent from the route index. There is NO back-fill: `runGeoTrack` folds in strict
`global_seq` order and **unconditionally** advances the checkpoint (`:215`) even when zero keyframes are
emitted, so a dropped keyframe is never reconstructed when the route later appears — the trip is
permanently missing from the map. Determinism holds (both live and rebuild seed the index from the same
persisted `geo_route` and fold in the same order, so both drop identically). Does not bite today:
`engine.ts:152-168` emits every `HubRegistered` then every `RouteRegistered` as a tick-0 bootstrap
BEFORE any operational event, so each leg's `RouteRegistered` has a lower `global_seq` than its
departures/arrivals. Reachable only if a `TrailerDeparted`/`TrailerArrivedAtHub` ever precedes its
leg's `RouteRegistered` (e.g. dynamically-added routes). No warning is logged, so a future drop is
silent.

**Why LOW.** Real but latent and bounded — no data corruption, no broken requirement, no determinism
threat today. No test exercises the out-of-order/null path.

**Fix.** Make the drop observable and/or guarded. Minimum: when `point===null` (`:97`, `:117`) emit a
warning (injected logger) with `(trailerId, tripId, kind, legKey)`. Stronger: document+assert the
bootstrap invariant (all `RouteRegistered` precede any leg use) at the catch-up runner boundary, OR have
the runner buffer unresolved `(trailerId, tripId, kind, hubPair)` tuples and re-emit once `upsertRoute`
makes the geometry available — keeping folding deterministic and the buffer rebuilt identically on
replay. If dynamically-added routes are out of scope, a comment plus a runtime assertion suffices.

---

### L-7 · api-ws · No global error handler — DB errors surface as Fastify default 500 with the raw error message
**File:** `packages/api/src/server.ts:35` (`{ logger: false }`, no `setErrorHandler`) · `queries.ts:95-99,116-120,138-142,159,176-182,192-197` (bare awaited queries)
**Kind:** security (information disclosure / observability)

**Evidence.** `server.ts:35` builds Fastify with `{ logger: false }` and registers no
`setErrorHandler`; grep confirms NO `setErrorHandler`/`onError` and NO try/catch in any route handler.
Every query handler awaits a Kysely query bare, so a throw reaches Fastify's default handler. Reproduced
with this repo's Fastify 5.8.5: an unhandled handler error returns HTTP 500 with body
`{"statusCode":500,"code":"42P01","error":"Internal Server Error","message":"relation \"package_location\"
does not exist"}` — proving the raw pg/Kysely message and code leak to the client, and with
`logger:false` nothing is recorded server-side. Params are validated (`idParamsSchema minLength:1`) and
all SQL is parameterized via Kysely, so this is disclosure/observability only, not injection.

**Why LOW.** The leak is internal schema/pg metadata (table names, error codes), not user data, secrets,
or credentials; the threat register dispositions information disclosure as accepted
(`01-05-PLAN.md:181` T-01-17, "synthetic data only, no PII") at explicit demo scale; only triggerable by
operational failures, not attacker-selected input.

**Fix.** In `buildServer` add `app.setErrorHandler((err, req, reply) => { req.log.error(err);
reply.code(500).send({ error: "internal_error" }); })` so the real error is logged server-side but the
client gets a generic body. Enable a logger (replace `{ logger: false }` with a real/injected logger);
keep tests quiet by injecting a silent logger in the inject-only test setup. No change to the 200/404
paths, so no regression.

---

### L-8 · api-ws · Wildcard CORS (`access-control-allow-origin: *`) on all responses
**File:** `packages/api/src/server.ts:38-41` and `packages/api/src/app.ts:18-21` (onRequest hook) · `queries.ts:11-20`
**Kind:** security (hardening debt)

**Evidence.** Both `server.ts:38-41` and `app.ts:18-21` set `access-control-allow-origin: *` via an
onRequest hook on every response. Refutation attempts all failed harmlessly: (1) route audit finds
ONLY GET handlers — the API is read-only (`queries.ts:11-20` documents "no mutation endpoints,
T-01-21"); (2) grep for cookie/credential/authorization/session returns nothing — no auth, no cookies,
and `access-control-allow-credentials` is NOT set, which per the Fetch/CORS spec structurally prevents
browsers from exposing any credentialed response even if cookies existed; (3) exposed DTOs are public
logistics/geo data with no PII or secrets. With no auth, no credentials, and read-only public data,
wildcard CORS lets any origin read data already public to anyone who can reach the host — nothing to
abuse. No OPTIONS/preflight handler exists, correct because every route is a simple GET.

**Why LOW.** Accurate finding; hardening debt, not a vulnerability, at demo scale.

**Fix.** Acceptable as-is for the local demo. Before any non-public/internet-facing deployment, replace
the manual wildcard onRequest hook in BOTH `server.ts` and `app.ts` with `@fastify/cors` configured to
an explicit origin allowlist (Vite dev origin + any prod web origin), factored into one shared helper
so the two files don't drift. Leave `access-control-allow-credentials` unset unless authenticated
credentialed requests are introduced — at which point a wildcard origin must NOT be used.

---

### L-9 · web-ol · Snapshot fixture sends a `hubs` array over ws that the client silently ignores — masks any future hub-over-ws contract drift
**File:** `packages/web/test/leak.e2e.ts:46-51` (fixture builds hubs[]) · `packages/api/src/ws/snapshots.ts:40-44,89` (server payload has hubs) · `packages/web/src/map/useTrailerSnapshots.ts:17-21,33-57` (`asSnapshot` reads only trailers) · `MapView.tsx:95-104,131-148`
**Kind:** maintainability

**Evidence.** Server `SnapshotMessage` carries both `trailers` and `hubs`; `buildSnapshot` returns
`{t, trailers, hubs}`. The leak fixture builds a `hubs[]` payload. The client `asSnapshot()` reads ONLY
`msg.trailers` and the client-side `SnapshotMessage` interface deliberately omits `hubs`. Confirmed hubs
come solely from `GET /api/hubs` (`MapView.tsx:95-104` builds the hub layer from `fetchHubs()`;
`onSnapshot` only calls `updateTrailerFeatures(source, snapshot.trailers)`). So the dead-payload
observation is accurate.

**Why LOW (and partly self-limiting).** This is a leak-guard test scoped by its own docstring to
trailer feature-count stability, not a wire-contract test — no reader would infer hub-over-ws coverage.
The fixture including hubs is arguably correct hygiene: it mirrors the REAL server payload, proving the
client tolerates a field it doesn't consume. Removing hubs would make the test DIVERGE from the actual
server message — its own (worse) form of drift. Minor documentation debt at most.

**Fix.** Do NOT strip hubs from the fixture — matching the real server payload is good fidelity. The
only worthwhile change is a one-line clarifying comment in `asSnapshot()` noting that hubs-over-ws are
intentionally ignored on the read side because hubs are static and loaded via `GET /api/hubs`. If
hubs-over-ws ever becomes load-bearing, add a dedicated contract test then; the leak test is not the
place to assert it.

---

### L-10 · projections · FND-04 reducer purity is proven behaviorally, not by an explicit static-scan test
**File:** `packages/projections/src/reducers/*.ts` (grep: no `Date.now`/`Math.random`) · `golden-replay.int.test.ts` · `01-VALIDATION.md:44`
**Kind:** maintainability (test-coverage)

**Evidence.** `01-VALIDATION.md:44` lists a "purity guard (no `Date.now`/`Math.random` in reducers)" as
part of FND-04, but there is no dedicated static-scan/lint test asserting the absence of those strings.
A grep confirms the reducer sources contain neither, and any impurity would break the byte-identical
golden-replay assertion (`expect(rebuiltSerialized).toBe(liveSerialized)`), so purity is proven
**behaviorally** rather than by an explicit lint-style test.

**Why LOW.** FND-04 is fully VERIFIED — the behavioral proof is strong (byte-equality would fail on any
impure reducer). This is a defense-in-depth/coverage nicety, not a gap in the requirement.

**Fix.** Add a cheap static-scan test (or ESLint rule scoped to `packages/projections/src/reducers/`)
asserting no `Date.now`/`Math.random`/`new Date()` usage, so a future impure reducer is caught at the
source line rather than only via a (slower) integration byte-equality failure.

---

## Disposition

- **Gate:** PASSED — 0 HIGH, requirements coverage complete (see `01-VERIFICATION.md`).
- **Before Phase 4 / concurrent-writer paths:** address **M-1, M-2** (event-store ordering) — these
  become live data-loss footguns the moment the optimizer or a background poller writes concurrently
  against the existing `readAll`/checkpoint consumers. Also fix **M-5** (ws crash) before any
  longer-running/externally-reachable deploy.
- **Opportunistic correctness hardening:** **M-3** (manifest as source of truth), **M-4** (trip-based
  arrival leg), **M-6** (StrictMode net-live invariant) — each removes a latent correctness/robustness
  trap whose data model is already present.
- **Carried debt (LOW):** L-1..L-10 scheduled into later phases; none block Phase 1.
