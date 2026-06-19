---
phase: 03-rfid-assisted-validation
plan: 07
type: execute
status: complete
requirements: [SNS-04, SNS-05]
---

# Plan 03-07 Summary — API exceptions feed + FP KPI + zone query + detection-in-driver

Surfaced Phase 3 over HTTP and CLOSED the vertical slice: the exception feed
(severity + recommendedAction), the false-positive-rate KPI, and per-package
zone-estimate queries — and extended the demo sim driver to run `runDetection`
each tick so a seeded NOISY run produces a LIVE, credible, non-flooding feed end
to end (sim emits RFID → fusion scores zones → detector compares planned vs
observed → exceptions surface, reproducibly per seed).

## New API endpoints (paths + DTO shapes)

All three are THIN, read-only, schema-validated (mirror `routes/queries.ts`),
registered in the composition root (`server.ts`) alongside `registerQueryRoutes`.
`registerExceptionRoutes(app, db: ApiDb)` in `packages/api/src/routes/exceptions.ts`.

- `GET /exceptions` (optional `?kind=wrong-trailer|missed-unload`, enum-validated)
  → `ExceptionDto[]`, deterministically ordered (occurredAt, then exceptionId):
  ```ts
  { exceptionId, kind, packageId, trailerId, hubId: string|null,
    severity, recommendedAction, confidence /* < 1.0 */, occurredAt }
  ```
  Backed by `readOpenExceptions(db)` (Plan 06). The `?kind` filter is applied
  read-side over the ordered feed.

- `GET /exceptions/kpi` → `ExceptionKpiDto`:
  ```ts
  { totalExceptions, lowConfidenceExceptions, falsePositiveRate /* low/total, [0,1] */ }
  ```
  Backed by `readExceptionKpi(db)` (Plan 06).

- `GET /packages/:id/zone` → `ZoneEstimateDto` (the OBSERVED layer surfaced); the
  freshest estimate across trailers (deterministic: `last_observed_at` desc, then
  `trailer_id`). 404 for an unobserved package (absence ≠ a fabricated estimate):
  ```ts
  { packageId, trailerId, estimatedZone, confidence /* < 1.0, anti-P5b */,
    lastReliableCheckpoint: string|null, lastObservedAt }
  ```
  **RFID-is-not-coordinates invariant carried to the wire (T-03-20):** the DTO
  exposes ONLY zone + confidence — there is NO (x, y)/lat/lon field (asserted in
  the int test).

All routes are READ-ONLY (T-03-22); the only writer remains the sim/detector via
the event store. Inputs validated by Fastify JSON schema (`:id` minLength, `kind`
enum) + parameterized Kysely (no string-concat SQL) (T-03-19).

## Driver's detection wiring (`packages/api/src/sim/driver.ts`)

`driveSimulation` gained two optional knobs: `rfid?: Partial<RfidSimConfig>` (when
present the stream carries `RfidObserved` and detection runs) and `detection?:
DetectionConfig` (defaults to `PRODUCTION_DETECTION_CONFIG`). Per-tick loop:

1. append the tick's events (OCC, grouped per stream) — and record each
   `TrailerDeparted.fromHubId` into a cumulative departed-hub set;
2. apply inline to the operational twin (incl. tag-registry → zone-estimate);
3. **NEW:** `runDetection(detectorReads(...), { config })` — PLANNED vs OBSERVED ⇒
   exception events appended via the OCC-safe `appendWithRetry`; then the fresh
   exception events are folded inline so the feed surfaces THIS tick;
4. advance catch-up projections; 5. broadcast ONE snapshot.

`detectorReads` binds `makeProjectionReads` (Plan 06) and **tightens the SNS-05
gate**: it overrides `readDepartedHubs` with the EXACT set of just-departed hub
ids (vs the MVP `in_transit` inference) — zero change to the detector core (DIP),
resolving Plan 06's carried risk #1. `readDestHub` is fed from a `PackageCreated`
dest-hub index built off the seeded stream (the PLANNED dest hub is not a
projection), resolving carried risk #2 in the composition root.

Detection is OFF when `rfid` is absent ⇒ the pre-RFID stream is byte-identical, so
the FND query + ws sim tests are untouched (backward-compatible).

## ONE production calibration band (resolves Plan 06 carried risk #4)

`packages/api/src/detection-config.ts` exports `PRODUCTION_DETECTION_CONFIG` — the
single source of detection calibration (DRY), shared by the driver and any future
caller. The anti-P5b fusion engine SATURATES the argmax zone mass in a TIGHT band
(empirically ~0.365 single-read floor … ~0.395 corroborated), so the Plan-04
defaults (`confidenceThreshold` 0.6, severity bands 0.7/0.85) are UNREACHABLE.

- `confidenceThreshold: 0.34` — just above the ~0.33 uniform floor.
- `highConfidenceThreshold: 0.366` — just above the single-read floor: a read
  CORROBORATED across the dwell window clears it.
- A **calibrated `severityFor`** (NOT the default): keyed off the detector's own
  SLA impact (which the detector derives from `highConfidenceThreshold`) —
  corroborated disagreement ⇒ `warning` (critical above ~0.45), single-read
  marginal blip ⇒ `info` (the FP rung the KPI counts). Reusing the DEFAULT
  `severityFor` would map EVERY exception to `info` (its 0.7 base band is
  unreachable), making the FP-rate read 1.0 by construction — meaningless. The
  calibrated mapping makes the FP-rate a real ratio that DISCRIMINATES credible
  from marginal.

## Anti-pattern defenses (re-verified end-to-end through the API)

- **Anti-P6 (keystone, through the wire):** detection is observation-driven; a
  planned-but-NEVER-observed package has NO exception AND its `GET .../zone` is a
  404 — absence is never a fabricated estimate or a manufactured "missing"
  (int test (c)/(d)). Every open exception has a backing zone observation.
- **Anti-P5b:** every surfaced `confidence` is < 1.0 (inherited from the capped
  fusion engine; the detector never re-derives it). Asserted on both the feed and
  the zone DTO.
- **No-flood (T-03-21):** stable-`exceptionId` dedupe (Plan 06) + the FP-rate KPI
  surfaced and asserted to discriminate (a credible `warning`+ exists; FP-rate
  strictly < 1.0; feed bounded ≤ observation count, never per-read).
- **Determinism:** same seed ⇒ identical feed (ids + severities), proven by
  re-driving a fresh fixture (int test (e)).

## Tests (TDD: RED → GREEN)

`packages/api/test/exceptions.int.test.ts` (6, Testcontainers Postgres + seeded
NOISY sim driven through `driveSimulation`):
(a) `GET /exceptions` yields plausible alerts WITH severity + recommendedAction,
deterministically ordered; (a') `?kind` narrows + rejects an invalid enum (400);
(b) `GET /exceptions/kpi` is a real ratio that discriminates (credible signal
present, FP-rate < 1.0, feed bounded — not flooded); (c) anti-P6: an unobserved
package is never flagged + every exception has a backing observation; (d) `GET
/packages/:id/zone` exposes zone + confidence < 1.0 and NO coordinates, 404 for
unobserved; (e) determinism per seed.

## Gates (run from the worktree, ALL GREEN)

- `pnpm install` — clean.
- `pnpm build` (turbo) — **9/9, no workspace cycles**.
- `pnpm -r build` — all packages Done.
- `pnpm lint` — clean (no `any`; no `Date.now`/`Math.random` in new src — time is
  the explicit `occurredAt`).
- `pnpm test:all` — **456/456 across 57 files** (was 450 baseline; +6 new; zero
  prior-test regressions, incl. all Phase-1/2 + Phase-3 Postgres suites).

## How Phase 5 consumes this (the demoable boundary)

Phase 5's UI polls/streams these three read-only endpoints: `GET /exceptions`
drives the alert panel (severity → color, recommendedAction → the operator's next
step, kind → wrong-trailer vs missed-unload badge); `GET /exceptions/kpi` renders
the false-positive-rate as the trust/credibility metric ("the feed is signal, not
noise"); `GET /packages/:id/zone` powers the per-package drill-down (zone +
confidence bar — never a map pin, honoring RFID-≠-coordinates). The driver's
per-tick detection means a live demo run populates all three in real time, in
lockstep with the existing ws snapshot channel.

## Carried residual risks (for integration / Phase 5)

1. **Calibration band is engine-specific.** `highConfidenceThreshold: 0.366` is
   tuned to THIS fusion engine's saturated output (~0.365 floor). If the fusion
   config (cap/entropy floor/prior) changes, the band must be re-derived — it is
   centralized in `detection-config.ts` so there is ONE place to retune.
2. **Per-tick detection captures the FIRST (lowest-confidence) sighting.** The
   dedupe pins an exception's severity to its first detection tick, so a later
   corroborated read does not upgrade it. This is intentional anti-flood
   behavior; if Phase 5 wants severity to escalate as evidence accrues, the
   exceptions reducer would need an upsert-on-higher-confidence rule (deferred —
   YAGNI for the MVP demo).
3. **Single-fixture noisy run.** The int test asserts properties (discriminating
   FP-rate, bounded feed) rather than exact counts, so it is robust to minor
   engine retuning; exact-count assertions were deliberately avoided.

---

## Integration addendum (merge into `feature/phase-3-rfid-assisted-validation`)

This plan was run as a two-rival tournament (`wt/p3-07-r1`, `wt/p3-07-r2`).
**Rival #2** won and was merged via `--no-ff` (commit
`3f6660ea29f9f82a835e7732d7ff18933825eb37`) — a clean merge, no conflicts.
Both rival worktrees and branches were removed and pruned after merge.

### Requirements delivered

- **SNS-04** — RFID/sensor exceptions surfaced as an actionable feed
  (`GET /exceptions`, `GET /exceptions/kpi`) with severity + recommendedAction
  and a false-positive-rate KPI that discriminates credible signal from marginal
  noise (no-flood honored).
- **SNS-05** — planned-vs-observed validation tightened at the API boundary: the
  driver feeds the detector the EXACT just-departed hub set (vs the MVP
  `in_transit` inference) and a `PackageCreated` dest-hub index, closing Plan 06's
  carried risks #1/#2; per-package zone estimate surfaced (`GET /packages/:id/zone`,
  zone + confidence < 1.0, NO coordinates, 404 for unobserved).

### Integration gate results (re-verified post-merge on the feature branch)

- `pnpm install` — clean (lockfile up to date).
- `pnpm build` (turbo) — **9/9 successful**.
- `pnpm -r build` — all 10 packages compiled (fresh `tsc -b` + `vite build`).
- `pnpm lint` — clean (eslint, 0 problems).
- `pnpm test:all` — **456 passed / 456, across 57 files**; the
  Testcontainers-backed integration suite (`queries.int.test.ts`,
  `exceptions.int.test.ts`) ran green in full — the suspected startup flake did
  NOT materialize on this run.

### Carried risks at integration (per judge)

1. **Integration-suite container-startup sensitivity.** The judge observed a
   full-suite flake where `queries.int.test.ts`'s `beforeAll` Testcontainers
   startup timed out under heavy parallel load — disproved as a code defect
   (8/8 in isolation), but it signals the integration suite is sensitive to
   container-startup contention on a loaded machine. **Action for CI (both
   rivals share this):** raise vitest `hookTimeout` and/or limit integration
   concurrency (single-fork / reduced `maxConcurrency`) so a loaded runner does
   not produce intermittent reds. Rival 1 was only luckier on ordering, not
   structurally safer.
2. **Fusion-engine calibration band is a shared dependency.** Detection relies on
   the anti-P5b fusion engine's saturated argmax (~0.34 threshold; saturated
   argmax confidence sits near ~0.40, so Plan-04's 0.6 default is unreachable).
   If the fusion config (cap / entropy floor / prior) changes, the band must be
   re-derived. Rival #2 centralizes this in ONE file (`detection-config.ts`,
   `PRODUCTION_DETECTION_CONFIG` + calibrated `severityFor`) — lower retune risk
   than rival 1's split between `DEMO_DETECTION_CONFIG` and the inherited
   `severityFor`.
3. **Severity pinned to the first sighting (intentional anti-flood, deferred
   YAGNI).** An exception's severity is fixed at its first detection tick and does
   NOT escalate as corroborating evidence accrues. If Phase 5 needs escalation,
   add an upsert-on-higher-confidence rule to the exceptions reducer.
4. **Per-trailer zone manifest unimplemented (YAGNI).** `GET /trailers/:id/zones`
   is not provided; only the per-package zone estimate is surfaced. Acceptable
   per the plan's or-clause — Phase 5 drives per-package drill-down, not a
   trailer-wide zone map.
