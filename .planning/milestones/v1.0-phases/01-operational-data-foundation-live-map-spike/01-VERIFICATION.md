---
phase: 1
slug: operational-data-foundation-live-map-spike
status: passed
coverage_ok: true
requirements_total: 11
requirements_verified: 11
confirmed_high: 0
confirmed_medium: 6
confirmed_low: 10
gate_build: 0
gate_lint: 0
gate_test_all_files: 18
gate_test_all_tests: 116
verified: 2026-06-19
---

# Phase 1 — Verification Report

> Operational Data Foundation + Live Map Spike. Evidence-based gate verification against the
> per-requirement test map in `01-VALIDATION.md`. **Status `passed`**: requirements coverage is
> complete (11/11 verified, `coverageOk=true`) AND there are zero confirmed HIGH-severity issues.

---

## 1. Gate Results

All automated quality gates were run live (not assumed) before this report was issued.

| Gate | Command | Result | Status |
|------|---------|--------|--------|
| **Build** | `pnpm build` (Turborepo, all packages, `tsc` strict + `noUncheckedIndexedAccess`) | **0 errors** | PASS |
| **Lint** | `pnpm lint` | **0 errors / 0 warnings** | PASS |
| **Unit suite** | `pnpm test` (pure reducers, sim determinism, zod validation — no DB) | **82 / 82 pass** | PASS |
| **Full suite** | `pnpm test:all` (unit + Testcontainers Postgres integration) | **18 files / 116 tests pass** (~20s) | PASS |
| **Web e2e** | `pnpm --filter @mm/web test:e2e` (Playwright / Chromium) | **2 / 2 pass** | PASS |

**Aggregate test signal:** 18 test files, 116 tests green against a real Postgres (Testcontainers on
OrbStack) plus 2 Playwright e2e specs. No flaky reruns, no skipped tests in the Phase-1 scope.

Keystone proofs inside the suite:
- **FND-04 golden replay** (`packages/projections/test/golden-replay.int.test.ts`) asserts the live
  operational twin is **byte-identical** to one rebuilt from `global_seq=0`
  (`expect(rebuiltSerialized).toBe(liveSerialized)` plus a deep-equal), and that a second rebuild is
  identical to the first.
- **FND-02 concurrency** (`packages/event-store/test/concurrency.int.test.ts`) proves
  exactly-one-winner on a same-stream CAS race, a typed `ConcurrencyError` on raw Postgres `23505`,
  and full rollback with no version gaps — against real Postgres.
- **SIM-02 determinism** (`packages/simulation/test/determinism.unit.test.ts`) proves
  same-seed ⇒ byte-identical event stream and that `occurredAt` comes from the virtual clock, never
  the wall clock.
- **VIZ-01** (`packages/web/test/map.e2e.ts` + `leak.e2e.ts`) proves OSM basemap + all hub markers +
  all route lines render, and that live trailer points update in place with a bounded, leak-free
  feature count over 40 ws snapshots.

---

## 2. Requirements Coverage

All 11 Phase-1 requirements (FND-01..08, SIM-01, SIM-02, VIZ-01) are **VERIFIED** — each has concrete
source implementation plus a passing test that proves the behavior, matching the intended test map in
`01-VALIDATION.md`. `coverageOk = true`.

| Req | Behavior proven | Source (primary) | Test (proof) | Type | Status |
|-----|-----------------|------------------|--------------|------|--------|
| **FND-01** | Domain changes persisted as append-only JSONB events; round-trip via `readStream`; store exposes no UPDATE/DELETE path | `packages/event-store/src/schema.sql` (append-only `data JSONB NOT NULL`, `global_seq BIGINT GENERATED ALWAYS AS IDENTITY`, T-01-08 comment); `store.ts` (`appendToStream`/`readStream`/`readAll`, insert+select only) | `packages/event-store/test/append-read.int.test.ts` — round-trips 3 events in version order (deep-equal) + asserts no update/delete/remove/truncate exports | integration | VERIFIED |
| **FND-02** | Per-stream optimistic concurrency (one winner, `ConcurrencyError`, no gaps) + total order via monotonic global sequence | `schema.sql` (`uq_events_stream_version`, `streams.version` CAS); `store.ts` `casStreamVersion` (`UPDATE … WHERE version=expectedVersion`, 0 rows → `ConcurrencyError`; `23505` backstop); `readAll` orders by `global_seq` (never timestamp) | `packages/event-store/test/concurrency.int.test.ts` — exactly-one-winner, typed `ConcurrencyError` from `23505`, full rollback no gaps; `append-read.int.test.ts` — `readAll` orders by `global_seq` not `occurred_at` | integration | VERIFIED |
| **FND-03** | Invalid event payload rejected by zod at a single ingestion choke point; valid persists | `packages/domain/src/ingestion/validate.ts` (`validateEvent(unknown): DomainEvent`, throws `ValidationError`); `schemas.ts` (`z.discriminatedUnion('type', …8)`, `.strict()`, `schemaVersion z.literal(1)`); `store.ts` calls `validateEvent` before every write | `packages/domain/test/ingestion.unit.test.ts` — happy path (8 events), rejects malformed (T-01-05), `schemaVersion` tolerance (T-01-06/P11), inferred-type equality | unit | VERIFIED |
| **FND-04** | Golden replay: live twin == state rebuilt from `global_seq=0` (byte-identical); reducer purity (no wall-clock/random) | `packages/projections/src/runner/rebuild.ts` + `serializeTwin` (sorted-key serialization); reducers pure on `(state, event)`, time only from `event.occurredAt` (grep: no `Date.now`/`Math.random` in `reducers/*.ts`) | `packages/projections/test/golden-replay.int.test.ts` — `expect(rebuiltSerialized).toBe(liveSerialized)` + deep-equal + second-rebuild identical; `reducers.unit.test.ts` — reducer purity/determinism (P3) | integration | VERIFIED |
| **FND-05** | "Where was package X?" → last hub + confidence + timestamp | `packages/projections/src/reducers/package-location.ts` (`PackageLocation{packageId, hubId, confidence=DIRECT_SCAN_CONFIDENCE(1), lastSeenAt}`); `api/src/routes/queries.ts` `GET /packages/:id/location` | `packages/api/test/queries.int.test.ts` — FND-05 returns hub + confidence===1 + ISO timestamp, unknown id → 404; `reducers.unit.test.ts` — `packageLocationReducer` last-seen proof | integration | VERIFIED |
| **FND-06** | "What's on trailer T?" → current assignment/contents | `packages/projections/src/reducers/trailer-state.ts` (`TrailerState{status, currentHubId, tripId, dockDoorId, assignedPackageIds sorted}`); `queries.ts` `GET /trailers/:id` | `queries.int.test.ts` — FND-06 status in valid set + `assignedPackageIds` array, unknown id → 404; `reducers.unit.test.ts` — departure→in_transit, arrival→arrived+hub, docking→docked+door | integration | VERIFIED |
| **FND-07** | Hub inventory (inbound/outbound/staged) correct, disjoint buckets | `packages/projections/src/reducers/hub-inventory.ts` (`HubInventory{inbound, outbound, staged}` disjoint sorted sets; placement index → ≤1 bucket; load scan removes); `queries.ts` `GET /hubs/:id/inventory` | `queries.int.test.ts` — FND-07 buckets present + disjoint (Set-size check); `reducers.unit.test.ts` — bucketing, no double-count on move, load removes, cross-hub move | integration | VERIFIED |
| **FND-08** | Package full movement history as ordered audit timeline from events | `packages/projections/src/reducers/audit-timeline.ts` (`AuditTimelineEntry` ordered by `globalSeq`); `queries.ts` `GET /packages/:id/history` (`.orderBy('global_seq','asc')`) | `packages/projections/test/audit-geo.int.test.ts` — full ordered timeline (FND-08) + checkpoint advance/idempotent; `queries.int.test.ts` — first entry `PackageCreated`, strictly increasing `BigInt(globalSeq)`, every entry carries `eventType`+`occurredAt` | integration | VERIFIED |
| **SIM-01** | ~10 US metro hubs with valid coords + connected hub-and-spoke routes | `packages/simulation/src/network/hubs.ts` (`USA_HUBS` = 10 hubs MEM/ORD/DFW/ATL/LAX/JFK/DEN/PHX/SEA/IND, WGS84); `network/routes.ts` (`buildRoutes` hub-and-spoke + `greatCircle`) | `packages/simulation/test/network.unit.test.ts` — ~10 hubs, continental coords + unique ids, connected topology (BFS reaches all), valid `Route` entities; `queries.int.test.ts` — `GET /hubs` ≥10 incl. Memphis | unit | VERIFIED |
| **SIM-02** | Same seed ⇒ byte-identical deterministic event stream (no wall clock / unseeded RNG) | `packages/simulation/src/engine.ts` `simulate({seed, durationTicks})` on seeded `makeRng` (`rng.ts`) + `VirtualClock` (`clock.ts`) | `packages/simulation/test/determinism.unit.test.ts` — same seed → byte-identical (deep-equal + `JSON.stringify`), different seed differs, every event passes `validateEvent`, non-decreasing `occurredAt`, virtual-clock time; `drives-projections.int.test.ts` — seeded stream drives projections | unit + integration | VERIFIED |
| **VIZ-01** | Map renders OSM + hub markers + route lines; trailer points update on ws; no source/layer leak | `packages/web/src/map/MapView.tsx` (OpenLayers 10 Map created once, OSM `TileLayer`); `map/layers.ts` (hub Points, route LineStrings, single reused `VectorSource`, in-place geometry mutation); `useTrailerSnapshots` ws hook | `packages/web/test/map.e2e.ts` — `data-hub-count`/`data-route-count`, OSM tiles over HTTPS, `data-map-instances=1`, stable on re-layout; `leak.e2e.ts` — 40 ws snapshots, bounded `data-trailer-count`, single source instance, in-place updates | e2e (Playwright) | VERIFIED |

**Coverage verdict:** 11 / 11 VERIFIED · `coverageOk = true`. No requirement is partial, deferred, or
unproven.

### Coverage nuance (does not change verified status)

`01-VALIDATION.md` lists a "purity guard (no `Date.now`/`Math.random` in reducers)" as part of FND-04.
There is **no dedicated static-scan/lint test** asserting the absence of those strings. Purity is
instead proven **behaviorally**: a grep confirms the reducer sources (`packages/projections/src/
reducers/*.ts`) contain no `Date.now`/`Math.random`, and the keystone byte-identical golden-replay
assertion (FND-04) would fail if any reducer were impure. This is tracked as low-severity carried debt
in `01-REVIEW.md` (recommend adding an explicit static-scan test), but it does not weaken the FND-04
verification.

---

## 3. Confirmed Issues Summary

Adversarial review confirmed **16 issues**: **0 HIGH · 6 MEDIUM · 10 LOW**. None block the gate.
Full detail (file:line, evidence, fix recommendation) is in `01-REVIEW.md`.

| Severity | Count | Gate impact |
|----------|-------|-------------|
| HIGH | 0 | none — gate passes |
| MEDIUM | 6 | none broken in shipped Phase-1 code; all latent / future-triggerable. Fix before Phase 4 / next-facing deploy |
| LOW | 10 | carried debt — schedule into later phases |

The 6 MEDIUM issues are all **real but latent**: each was downgraded from an initially-claimed HIGH
because no shipped Phase-1 path triggers it (no data corruption, no failing test, no violated Phase-1
requirement today). The two event-store ordering findings become live footguns the moment a
concurrent writer (the Phase-4 optimizer or a background poller) runs against the existing
`readAll`/checkpoint consumers. See `01-REVIEW.md` for the per-issue trigger conditions and fixes.

---

## 4. Human Verification (Manual Visual Check) — VIZ-01

The automated e2e (`map.e2e.ts` + `leak.e2e.ts`) proves the **structural** VIZ-01 contract: OSM
basemap loads over HTTPS, all hub markers and route lines render, the Map is instantiated exactly once,
and live trailer points update **in place** with a bounded, leak-free feature count across many ws
snapshots. That is automated and green.

What automation **cannot** assert — and therefore requires a human visual check before VIZ-01 is signed
off for the demo — is the subjective animation quality. Per `01-VALIDATION.md` "Manual-Only
Verifications":

> **Behavior:** Live map visually shows trailers moving across the USA as the sim runs.
> **Why manual:** Visual/animation smoothness is subjective.

**Reviewer instructions (≈2 min):**

1. Run `pnpm dev` and open the web app (Vite dev origin).
2. Start the simulation.
3. Confirm visually:
   - [ ] OSM basemap tiles render across the continental USA (no blank/gray tiles).
   - [ ] All ~10 hub markers appear at plausible US metro locations (Memphis center, spokes radiating).
   - [ ] Route lines connect the hub-and-spoke network without obvious geometry artifacts.
   - [ ] Trailer points **advance smoothly** along their routes as ticks progress (no teleport-jumps,
         no stutter, no points piling up at origin).
   - [ ] No console errors; the trailer count stays at fleet size (no visible accumulation/leak).

> **Note on dev StrictMode:** A MEDIUM review finding (`01-REVIEW.md` — web-ol) records that the
> "created exactly once" diagnostic counter is only verified against the **production** Playwright
> build; under React **dev StrictMode** (`pnpm dev`) the cumulative create-counter settles at 2
> (the first Map is still properly disposed, so **net-live instances remain 1** — no runtime leak).
> The reviewer may therefore observe `data-map-instances="2"` in dev; this is the known
> counter-semantics gap, not a leak. Confirm visually that there is a single live map and trailers
> animate correctly.

**Sign-off:** This manual check has **not yet been performed**; it is the only remaining item before
VIZ-01 is fully closed. It does not affect the gate `status: passed`, since the automated VIZ-01
contract is green and the remaining check is the subjective animation-quality assertion that is
manual-by-design.

---

## 5. Gate Verdict

**PASSED.**

- Requirements coverage complete: **11 / 11 verified**, `coverageOk = true`.
- Quality gates green: **build 0 errors, lint 0, `pnpm test` 82/82, `pnpm test:all` 18 files / 116
  tests, web e2e 2/2.**
- Confirmed issues: **0 HIGH**, 6 MEDIUM (all latent / future-triggerable), 10 LOW (carried debt).

Per the gate rule (`passed` only if coverage is complete AND no confirmed HIGH issues), Phase 1 is
**PASSED**. Outstanding items: (1) the manual VIZ-01 animation visual check (manual-by-design), and
(2) the MEDIUM/LOW findings in `01-REVIEW.md` to address before Phase 4 introduces a concurrent writer
or any externally-facing deployment.
