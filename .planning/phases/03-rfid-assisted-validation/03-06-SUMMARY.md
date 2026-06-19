---
phase: 03-rfid-assisted-validation
plan: 06
type: execute
status: complete
requirements: [SNS-04, SNS-05]
---

# Plan 03-06 Summary — Detector + exceptions projection + FP KPI

Wired the DECISION-CRITICAL core of Phase 3: the detector that reads the PLANNED
layer (trailer-state assignment + dest hub) and the OBSERVED layer (the fused
`zone_estimate` read model), runs the pure Plan-04 predicates, and — on positive
ABOVE-THRESHOLD disagreement — appends `WrongTrailerDetected` /
`MissedUnloadDetected` events. An INLINE exceptions read model surfaces the open
exceptions (severity + recommendedAction) and a false-positive-rate KPI; the
anti-P6 keystone (absence ⇒ never an exception) is proven END-TO-END through the
detector against real Postgres.

## `runDetection` — signature + where it hooks in

```ts
// @mm/projections (acyclic — never imports @mm/event-store; DIP via ports)
interface DetectorReads {
  readPlannedAssignments(): Promise<readonly PlannedAssignment[]>; // PLANNED
  readObserved(): Promise<readonly ZoneEstimate[]>;                // OBSERVED
  readDepartedHubs(): Promise<readonly string[]>;                  // SNS-05 gate
  readExistingExceptionIds(): Promise<ReadonlySet<string>>;        // dedupe
  readonly append: AppendExceptions; // the ONLY write side effect (OCC-guarded)
}

runDetection(reads: DetectorReads, opts: { config; occurredAt? }): Promise<DomainEvent[]>

// Pure core (no I/O) — fully unit-testable:
planDetection(planned, observed, departedHubs, existingExceptionIds, config): PlannedAppend[]

// Adapter binding the ports to a live Kysely<ProjectionDb> + injected append:
makeProjectionReads(db, { readDestHub, append }): DetectorReads
```

`runDetection` reads the two layers, calls `detectWrongTrailer` over ALL
observations + `detectMissedUnload` for each departed hub, dedupes by a stable
`exceptionId`, and appends each NEW candidate via the injected `append`
(`appendWithRetry`, OCC). **Plan 07** calls `runDetection` in the sim driver
loop (after the per-tick inline apply) and exposes the feed + KPI via
`GET /exceptions` — it can inject the EXACT just-departed hub through the same
`readDepartedHubs` port (DIP), tightening the SNS-05 gate with zero change to the
detector core.

### Anti-cycle design (the load-bearing constraint)
`@mm/event-store` depends on `@mm/projections`, so the detector CANNOT import the
event store. It takes its append + reads through `DetectorReads` (dependency
inversion). The real-Postgres + seeded-sim end-to-end therefore lives in
`@mm/api` (which depends on both, acyclically) — the same pattern Plan 05 used.
Turbo `pnpm build` stays 9/9 with no workspace cycles.

## Exceptions read model + tables

- `exceptionsReducer` / `emptyExceptionsState` / `ExceptionsState`
  (`reducers/exceptions.ts`): folds `WrongTrailerDetected` ⇒ `{ kind:
  "wrong-trailer", packageId, trailerId, severity, recommendedAction, confidence,
  occurredAt }` and `MissedUnloadDetected` ⇒ `{ kind: "missed-unload", ..., hubId
  }`. Exhaustive over the closed 11-event union; the other 9 events are no-ops
  (same reference). Idempotent on a stable `exceptionId` (`kind:pkg:trailer:hub`).
- `openExceptions(state)` orders deterministically by `occurredAt` then
  `exceptionId`. `readOpenExceptions(db)` / `readExceptionKpi(db)` are the read
  side.
- Tables (in BOTH `schema.sql` and the byte-identical `PROJECTIONS_SCHEMA_SQL`;
  the drift test guards them):
  - `exceptions (exception_id PK, kind, package_id, trailer_id, hub_id NULL,
    severity, recommended_action, confidence, occurred_at)`.
  - `exception_kpi (id BOOLEAN PK singleton, total_exceptions,
    low_confidence_exceptions)`.
- Wired as the `"exceptions"` operational projection (`applyExceptions` in
  `runner/inline.ts`, its own `last_seq` checkpoint; added to the rebuild
  TRUNCATE). Inline ⇒ read-your-writes; the `last_seq` skip makes re-apply a
  strict no-op (P5a).

## False-positive-rate KPI definition

`falsePositiveRate(state) = lowConfidenceExceptions / totalExceptions` (0 when
none — no divide-by-zero). "Low-confidence" is `severity === "info"`
(`FALSE_POSITIVE_SEVERITY`) — the LOWEST rung the detector's calibrated
`severityFor` assigns to the marginal, near-the-gate disagreements most likely to
be false positives. Tying the KPI to `severity` (a calibrated detection output)
rather than a raw-confidence magic number keeps ONE calibration source and is
robust to the fusion engine's bounded confidence (see calibration note). A real,
queryable ratio — the demo metric proving the feed stays credible.

## Calibration finding (carried to Plan 07)

The anti-P5b fusion (likelihood cap 0.85 + 2% entropy floor + Markov prior)
SATURATES the argmax-zone `confidence` near **~0.40** — it can never approach
1.0. So the Plan-04 `DEFAULT_DETECTION_CONFIG.confidenceThreshold` of **0.6 is
unreachable** by this engine: wrong-trailer would never fire in production at
that gate. Detection must be calibrated to the observed-confidence distribution;
the `@mm/api` end-to-end uses a realistic `confidenceThreshold: 0.34` (just above
the ~0.33 uniform floor) + `highConfidenceThreshold: 0.395`. **Plan 07 should set
the production detection config to this calibrated band** (or expose it as a
tunable). The pure predicates are correct; only the threshold constant needs the
real-world value.

## Tests (all green)

- `test/exceptions.unit.test.ts` (8) — reducer truth table, idempotency,
  deterministic order, severity-based FP-rate, purity, exhaustive no-ops.
- `test/detector.int.test.ts` (7, `@mm/projections`) — end-to-end over the real
  reducers + pure predicates via in-memory snapshots: wrong-trailer fires,
  missed-unload fires only post-departure, **absence ⇒ zero exceptions**,
  partial-loss ⇒ only the observed-and-disagreeing fires, re-run idempotent (no
  flood), FP-rate low on a credible run.
- `test/detector.int.test.ts` (3, `@mm/api`, **Testcontainers Postgres + seeded
  noisy RFID sim**) — (a) a deliberate wrong-trailer read ⇒ exactly one persisted
  `WrongTrailerDetected` (severity + action + confidence < 1.0); (b) the anti-P6
  keystone: a planned-but-NEVER-observed GHOST package is never flagged, and
  EVERY open exception has a backing observation; (c) re-running detection is
  idempotent (no double-count) + the FP-rate KPI is a real ratio in [0,1].
- `test/schema-sql.test.ts` extended: asserts the `exceptions` + `exception_kpi`
  tables and byte-identical DDL.

## Gates (run from the worktree, ALL GREEN)

- `pnpm install` — clean.
- `pnpm build` (turbo) — **9/9, no workspace cycles** (`@mm/projections` →
  `@mm/sensor-fusion` → `@mm/domain`, downward only; the detector uses DIP so it
  never imports `@mm/event-store`).
- `pnpm -r build` — all packages Done.
- `pnpm lint` — clean (no `any`; no `Date.now`/`Math.random` in new src — time is
  the explicit `occurredAt`).
- `pnpm test:all` — **450/450 across 56 files** (was 431 baseline; +19 new; zero
  prior-test regressions, incl. all Phase-1/2 Postgres suites).

## Anti-pattern defenses (re-verified)

- **Anti-P6:** detection is observation-driven (the predicates iterate OBSERVED,
  consult the plan by id). The `exceptionsReducer` folds ONLY the two detection
  events; every other event is a no-op. The `@mm/api` GHOST test proves a
  planned-but-unread package is NEVER flagged, and every open exception has a
  backing observation. Missed-unload is gated post-departure.
- **Anti-P5b:** the OBSERVED confidence is inherited from the capped fusion
  engine (< 1.0); the detector never re-derives or amplifies it. Detection is
  one-way downstream of fusion (no feedback into the likelihood engine).
- **No-flood (T-03-16):** stable `exceptionId` dedupe + idempotent inline fold;
  re-running detection re-appends nothing (proven in both int suites).
- **OCC (T-03-17):** the detector appends via `appendWithRetry` (expected-version
  + reload-retry) — a concurrent writer alongside the sim converges safely.
