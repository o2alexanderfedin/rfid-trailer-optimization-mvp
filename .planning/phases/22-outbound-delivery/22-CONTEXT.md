# Phase 22: Outbound Delivery - Context

**Gathered:** 2026-06-25
**Status:** Ready for planning (decisions locked via research + Google AI Mode consult)
**Mode:** Autonomous smart-discuss (research-locked decisions + 2-round Google AI Mode consult)

<domain>
## Phase Boundary

Freight reaching its **destination hub** exits the network via a new `PackageDelivered`
**terminal** domain event, fired after a **seeded outbound dwell**, carrying an **on-time SLA flag**.
The event **DELETE-purges** the package from read-model projections (`packageLocation`,
`hubInventory`, `zoneEstimate`), completing the **bounded-memory** story
(composes with Phase-19 event-log retention + Phase-21 detection active-scoping).
A **VIZ-14** destination-hub highlight animates each delivery on the live map, and a
**(P2) KPI** widget shows delivered-out count + on-time %.

This closes the end-to-end freight lifecycle:
**induction (P20) → transit → consolidation (P21) → distribution → delivery (P22)**.

**In scope:** OUT-01, OUT-02, OUT-03, OUT-04, VIZ-14, OUT-05 (P2).

**NOT in scope:** returns / reverse-logistics as a fourth flow (FLOW-FUT-01); real WMS/TMS
delivery confirmation; proof-of-delivery artifacts.
</domain>

<decisions>
## Implementation Decisions

### Determinism keystone (CRITICAL — every prior phase held this)
- **Opt-in:** `outboundDeliveryEnabled: false` (default) ⇒ ZERO `PackageDelivered` events ⇒
  ZERO new RNG draws ⇒ ZERO projection purges ⇒ seed-1234 + seed-42
  (`3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861`) goldens **byte-identical**.
  This is the non-negotiable acceptance gate.
- The golden hashes the **sim event stream + engine world state**, NOT projection tables — so a
  hard DELETE in a projection reducer cannot affect the golden (confirmed in Google consult round 2).

### D-22-1 — Purge mechanism = hard DELETE (research-locked + consult-confirmed)
- On `PackageDelivered`, the projection reducers **DELETE** the package's rows from
  `packageLocation`, `hubInventory` (its contribution), and `zoneEstimate` — **not** a soft-delete /
  tombstone. OUT-04 (bounded table size) **requires** true row removal; a tombstone leaves rows and
  does not bound growth.
- **Safe because:** replay-from-zero re-folds the same ordered event stream, so the DELETE executes at
  the exact same logical step every replay → fully deterministic. The classical "never hard-delete in
  event sourcing" warning assumes you reconstruct state FROM projections or do DB time-travel; we do
  neither (golden is over the sim stream).
- **Reducer must be idempotent + crash-safe:** `DELETE WHERE id = …` is a natural no-op on a missing
  row. The reducer MUST NOT throw if the row is already absent (covers any at-least-once re-apply /
  replay overlap). No read-modify-write that assumes the row exists.

### D-22-2 — Ordering: strictly-positive dwell, comparator UNCHANGED (KISS/YAGNI)
- Outbound dwell is **strictly positive (≥ 1 tick)**, so `PackageDelivered` is always at a
  **strictly-later tick** than the `PackageArrivedAtHub` that triggered it. The existing
  `(tick, sequenceId)` event ordering therefore already guarantees arrival-before-delete.
- **Rejected** the Google consult's proposed `⟨tick, phasePriority, sequence⟩` 3-tier comparator:
  injecting a middle "phase priority" tier would reorder **existing** events and **break the goldens**.
  The strictly-positive dwell eliminates the same-tick delete hazard without touching the comparator.
- Guarantees `PackageArrivedAtHub` is **no longer terminal**; every arrived package at its DESTINATION
  hub schedules exactly one delivery (terminal-completeness).

### D-22-3 — KPI is event-derived, not a row-count (consult round 2)
- OUT-05 KPI (delivered-out count + on-time %) is its **own projection reducer** that increments
  `deliveredCount` / `onTimeCount` on each `PackageDelivered` event. It MUST NOT be a `COUNT(*)` over
  the package tables (those rows are being DELETE-purged, so a row-count would undercount). Monotonic,
  event-derived aggregate — survives the purge.

### D-22-4 — RNG: new salted substream, captured in continuation
- Add `OUTBOUND_RNG_SALT` (a new hash-split XOR salt for the existing mulberry32+splitmix32
  substream pattern), **pairwise-distinct** from all prior salts (assert in the salts test). It seeds
  the **outbound dwell duration** draw.
- Built **only when** `outboundDeliveryEnabled` (lazy, like `INDUCTION_RNG_SALT`) so flags-off makes no
  new draws.
- The substream's **internal PRNG state + any pending-delivery task + a `deliveredCounter`** are
  captured in `SimContinuation` (RNG `getState`/`makeRngFromState`) and re-instantiated on resume —
  exactly the Phase-20 induction pattern. Add a continuation-equivalence case with
  `outboundDeliveryEnabled: true` crossing a chunk boundary mid-dwell (chunked == all-at-once
  byte-identical).

### D-22-5 — onTime flag
- `PackageDelivered.payload.onTime = (deliveredAt <= slaDeadlineIso)`, computed at emit.
- `slaDeadlineIso` is already locked on the package at induction (Phase 20). `deliveredAt` is the sim
  clock at the delivery tick rendered to ISO with the **same whole-minute canonicalization** Phase 20
  used for deadlines (avoid sub-minute key-order / formatting drift across continuation boundaries).

### Claude's discretion
- Outbound dwell distribution / mean (deterministic, seeded) — tuned so deliveries are watchable in the
  demo without instantly draining hubs.
- VIZ-14 highlight style (color/pulse) — distinct from VIZ-13 induction (purple) and VIZ-12
  consolidation (cyan).
- Whether the dwell is scheduled as a self-contained `EventQueue` task at arrival (preferred, mirrors
  Phase-20 `inductPackage`) vs. polled — pick the EventQueue task (no external append, deterministic).
</decisions>

<code_context>
## Existing Code Insights (precise anchors pinned by code-explorer + verified in plan-phase)
- **Event union 5-file ceremony** (Phase 20 `PackageInducted` is the template): add `PackageDelivered`
  to the closed `DomainEvent` union, its `.strict()` schema, the exhaustive `contract.assert`/switch,
  the `validate()` round-trip, and the event-type registry (packages/domain/src).
- **Arrival emit site** in `packages/simulation/src/engine.ts`: where `PackageArrivedAtHub` fires on a
  trailer reaching a hub. At the DESTINATION hub this currently ends the package's journey (no further
  event) — Phase 22 schedules the dwell→delivery here instead of treating arrival as terminal.
- **Projection reducers** (packages/projections/src/reducers/): `packageLocation`, `hubInventory`,
  `zoneEstimate` — add a `PackageDelivered` case that DELETEs the package's row(s). The
  Phase-21 detector active-scoping already excludes delivered (inactive) packages from detection cost.
- **RNG salts**: `INDUCTION_RNG_SALT = 0x8f2c4ae1` (7th substream) + the 6 prior salts; add
  `OUTBOUND_RNG_SALT` and extend the pairwise-distinct assertion test.
- **SimContinuation** (packages/simulation/src/continuation.ts): mirror how the induction substream
  (RNG state + pending task + `inductionCounter`) and `world` queues (pendingBySpoke / pendingAtSpoke)
  are captured/restored; add the outbound substream state + pending-delivery task + `deliveredCounter`.
- **Comparator / tie-break**: the `(tick, sequenceId)` EventQueue ordering — leave UNCHANGED (D-22-2).
- **Golden test**: seed-42 10k-tick SHA `3920accc…` over the sim stream/world — must stay byte-identical
  with the flag off.
- **WS TickPayload + map**: `TickPayload.inductionEvents` (tick-only, Phase 20) is the template for a
  `deliveryEvents` tick field; `createInductionLayer`/`flashInduction` (packages/web) is the template
  for a VIZ-14 destination-highlight layer. KPI widget joins the existing operator-panel set
  (cf. Phase-21 `HubBalance`).
- Gate: `pnpm build` + `pnpm typecheck` + `pnpm lint` + `pnpm test:all`. **Gate-hygiene:** bound any
  new continuation/Postgres-heavy test scale; run ONE gate at a time with heap bump (see
  memory `v2-gate-hygiene-oom`).
</code_context>

<specifics>
## Specific Ideas
- `outboundDeliveryEnabled?: boolean` on `SimulateOptions` (off by default), gating: the dwell task
  scheduling at destination arrival, the `OUTBOUND_RNG_SALT` substream build, `PackageDelivered`
  emission, the projection purge, and the `deliveryEvents` WS field.
- Self-rescheduling/one-shot `deliverPackage` EventQueue task scheduled at destination arrival with a
  seeded `dwell ≥ 1` tick; on fire, emit `PackageDelivered{ packageId, hubId, deliveredAt, onTime }`.
- Purge reducers: `DELETE` keyed by packageId; idempotent no-op on missing row; never throw.
- KPI reducer: independent `delivery_kpi` projection (deliveredCount, onTimeCount) → API → operator
  widget. Event-derived, not row-count.
- VIZ-14: `deliveryEvents` on the ws tick (never in snapshot → no reconnect re-flash, per Phase-20
  Pitfall-7); destination hub pulse highlight.
- Lifecycle-ordering test: `PackageDelivered` always follows `PackageArrivedAtHub` for the same package.
- Terminal-completeness test: with flag on, every package reaches `PackageDelivered` within the horizon.
- Bounded-memory test: continuous multi-cycle run with flag on keeps projection row counts bounded
  (rows for delivered packages are gone), while flag off keeps the golden byte-identical.
</specifics>

<deferred>
## Deferred Ideas
- Returns / reverse-logistics as a fourth flow direction (FLOW-FUT-01).
- Proof-of-delivery artifacts / real delivery confirmation integration.
- Per-destination SLA dashboards beyond the single on-time% KPI.
</deferred>

<google_consult>
## Google AI Mode Consultation (2026-06-25, udm=50, reached — 2 rounds)

**Round 1 — terminal-event purge + new RNG substream, general pitfalls.**
- Flagged hard-DELETE pitfalls (time-travel-to-intermediate failures, downstream join failures, lost
  lineage) and offered soft-delete/tombstone OR deterministic tombstoning bound to the **virtual sim
  clock + a deterministic grace window**. Confirmed RNG best practice = **hierarchical salted
  sub-seed** + **serialize internal PRNG state** and re-instantiate on resume (matches our pattern).

**Round 2 — pressure-test with our specifics (golden over sim stream not projections; opt-in;
replay-from-zero is a pure fold).**
- **Confirmed hard DELETE is safe for us:** core reproducibility loop is insulated from the projection
  layer; replay re-evaluates the same ordered events → DELETE is deterministic; OUT-04 bounded size
  makes hard deletion appropriate. The classical warning "does not apply to your primary engine state."
- **Residual risks surfaced (folded into decisions):**
  1. **Idempotency / re-apply:** a purged row loses its processing history; a retried/re-read
     `PackageDelivered` can't look up the row to dedupe → make the DELETE reducer a **no-op on missing
     row** (D-22-1).
  2. **Downstream aggregates:** a metric reducer must NOT count rows in a purged table — it must keep
     its **own event-decremented/incremented counter** (D-22-3 KPI is event-derived).
  3. **Lost auditability:** acceptable for a demo — the event log retains every `PackageDelivered`
     fact; auditability lives in the log, not the projection.
- **Within-tick ordering:** proposed a `⟨tick, causalPhasePriority, monotonicSequence⟩` comparator.
  **We rejected the phase-priority tier** (would reorder existing events → break goldens) and instead
  enforce a **strictly-positive dwell** so delivery is always a later tick than arrival → existing
  `(tick, sequenceId)` already orders correctly (D-22-2). This is the KISS/determinism-safe resolution.
</google_consult>
