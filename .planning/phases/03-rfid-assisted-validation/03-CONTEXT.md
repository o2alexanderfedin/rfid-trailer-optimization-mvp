# Phase 3: RFID-Assisted Validation - Context

**Gathered:** 2026-06-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Ingest RFID/barcode reads as **confidence-scored probabilistic evidence** (never coordinates), produce
per-package rear/middle/nose **zone estimates** via rule-based Bayesian fusion, and detect **wrong-trailer**
and **missed-unload** events by comparing the PLANNED/KNOWN state (scans + the Phase-2 plan) against the
OBSERVED evidence — raising exceptions (with severity + recommended action) only on disagreement above a
confidence threshold. The simulator emits probabilistic RFID reads (configurable miss-rate + noise).

**In scope (requirements):** SNS-01 (confidence-scored ingestion), SNS-02 (tag→package mapping),
SNS-03 (Bayesian zone estimate), SNS-04 (wrong-trailer detection), SNS-05 (missed-unload detection),
SIM-03 (simulator emits probabilistic RFID reads).

**Out of scope (later phases):** ML sensor fusion (HMM/particle filters — anti-feature, never); the rolling
optimizer / min-cost flow / VRP (Phase 4); the exception-feed UI, confidence heatmaps, animation (Phase 5).

Detection FOLLOWS load planning because it compares *planned* (Phase 2) vs *observed* (RFID) — both must
already exist. The two cardinal risks are defended explicitly:
- **P6 (RFID-as-truth):** two explicit layers (planned/known vs confidence-scored observed); exceptions
  only on disagreement above threshold; **a missing read NEVER implies "package gone"** (absence of
  evidence ≠ evidence of absence). Track the false-positive rate as a demo KPI.
- **P5b (double-counted observations):** per-tag / per-reader / per-dwell observation WINDOWS feed ONE
  fused observation, with an explicit independence model that CAPS confidence (never asymptotes to 1.0
  from repeated reads of the same tag in one dwell).
</domain>

<decisions>
## Implementation Decisions

### Sensor Model & Ingestion (SNS-01, SNS-02, SIM-03)
- RfidObserved event shape (spec §8.3): `{ tagId, readerId, antennaId, rssi, trailerId, hubId, confidence, occurredAt }` (phase optional). Barcode scans reuse the existing PackageScanned (deterministic, confidence 1.0 at a known checkpoint).
- RSSI → probability: a rule-based MONOTONIC mapping (stronger RSSI ⇒ higher per-read confidence), parameterized by reader/antenna TYPE priors (dock-door portal = high reliability; trailer antenna = zone-ish, lower). Never treat RFID as exact position.
- Tag → package (SNS-02): a registry projection mapping `tagId → packageId` built from `PackageCreated` (packages carry an `rfidTagId`). Unmapped tags are logged, not exceptions.
- Sim RFID emission (SIM-03): extend `@mm/simulation` to emit RfidObserved at dock-door portals (on dock/load) and trailer antennas (during dwell) with a configurable `missRate` (some reads dropped) and `noise` (RSSI jitter, occasional wrong-zone/wrong-tag reads). Seeded + deterministic (same seed ⇒ identical RFID stream). No real hardware.

### Sensor Fusion & Zone Estimate (SNS-03)
- New PURE module `@mm/sensor-fusion`: rule-based Bayesian zone fusion over {rear, middle, nose}. Each windowed observation contributes a likelihood (reader/antenna location ⇒ zone evidence); posterior updated from a prior; output a confidence-scored zone estimate.
- Dwell windowing (anti-P5b): collapse repeated reads of the SAME tag within a dwell window (keyed tag/reader/dwell) into ONE windowed observation BEFORE fusion; an explicit independence model CAPS posterior confidence (e.g. a max-confidence ceiling / discounted evidence) so repetition never drives confidence → 1.0.
- Estimate output (spec §8.4): `{ packageId, trailerId, estimatedZone, confidence, lastReliableCheckpoint, lastObservedAt }`.

### Detection (SNS-04, SNS-05) — anti-P6
- TWO explicit layers: PLANNED/KNOWN (from barcode scans + the Phase-2 load plan / assignment) vs OBSERVED (the confidence-scored RFID zone/trailer estimate). Detection compares them; an exception fires ONLY on disagreement ABOVE a configurable confidence threshold.
- Wrong-trailer (SNS-04): a package POSITIVELY observed (confidence > threshold) in a trailer the plan did NOT assign ⇒ exception `{ severity, recommendedAction }` (e.g. recheck_before_departure; block_departure if high + pre-departure). Only on positive observation in the wrong place.
- Missed-unload (SNS-05): a package destined for the just-departed hub still OBSERVED in the trailer after TrailerDeparted ⇒ exception `{ severity, recommendedAction }` (return / cross-dock / over-carry / transfer).
- **Absence ≠ missing**: a missing/absent RFID read NEVER marks a package missing or vanished and NEVER raises an exception by itself (success criterion 5). The exception feed must not be flooded with false positives.
- Severity + threshold are configurable; severity derives from confidence × SLA impact.

### Architecture
- `@mm/sensor-fusion` is PURE (import only @mm/domain): RSSI→prob, dwell windowing, Bayesian zone fusion, and the detection predicates — fully unit/property testable.
- New domain events added to the CLOSED event union: `RfidObserved` (sim emits), `WrongTrailerDetected`, `MissedUnloadDetected` (detection emits). Adding union members will require updating @mm/domain's `contract.assert.ts` + zod schemas — EXPECTED (the build-gate enforces exhaustive handling; this is the correct, guided way to extend the union, unlike Phase 2 which added only entity types).
- Exceptions projection is DECISION-CRITICAL ⇒ INLINE (read-your-writes current-exceptions view) in `@mm/projections`; tag→package and zone-estimate read models likewise. The detector writes WrongTrailerDetected / MissedUnloadDetected events.
- API: `GET /exceptions` (the exception feed) + per-package/per-trailer zone estimates; expose a **false-positive-rate** KPI. Demoable; reuses Phase-1 query conventions.

### Testing
- Property/unit: confidence is monotonic in RSSI; dwell windowing collapses repeats; repeated same-tag reads NEVER push confidence to 1.0 (the P5b cap).
- Detection truth tables: positive wrong-place obs above threshold ⇒ exception; below threshold ⇒ none; ABSENCE of reads ⇒ NEVER an exception / never "missing" (the P6 keystone test).
- Missed-unload fires only post-departure with the package still observed for the departed hub.
- Sim determinism: same seed ⇒ identical RFID stream (incl. drops/noise).
</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `@mm/domain` — entities + closed event union (extend with the 3 new events + their zod schemas + contract.assert).
- `@mm/event-store` / `@mm/projections` — append + inline/catch-up projections; add the tag-registry, zone-estimate, and exceptions read models; detector appends exception events.
- `@mm/simulation` — extend to emit RfidObserved (miss-rate + noise, seeded).
- `@mm/load-planner` — the Phase-2 plan/assignment is the PLANNED layer detection compares against.
- Conventions (Phases 1-2): pnpm+Turborepo, strict TS (no any, noUncheckedIndexedAccess), Vitest unit + Testcontainers integration, ESLint flat, downward-only deps, determinism discipline, **gates include turbo `pnpm build`** (the Phase-2 lesson).

### Established Patterns
- Pure scoring modules with golden + property tests (mirror @mm/sensor-fusion on @mm/load-planner / @mm/projections).
- Git-flow: work on `feature/phase-3-rfid-assisted-validation`; pre-commit blocks main/develop (merges allowed).

### Integration Points
- Detector reads PLANNED (plan/scans) + OBSERVED (fused estimates) → emits exception events → inline exceptions projection → API feed. Phase 5 consumes the exception feed + zone confidence for the UI.
</code_context>

<specifics>
## Specific Ideas
- The P6 keystone test: ABSENCE of RFID reads must NEVER produce an exception or a "missing package" — assert explicitly.
- The P5b keystone test: N repeated same-tag/same-dwell reads produce a confidence that is CAPPED (strictly < 1.0 and below a configured ceiling), not asymptotically 1.0.
- RFID is probabilistic evidence, never coordinates — no estimate exposes an (x,y); only zone + confidence.
</specifics>

<deferred>
## Deferred Ideas
- ML sensor fusion (HMM/particle filter/ML classifier) — anti-feature; never in this MVP.
- Rolling optimizer / min-cost flow / VRP / local repair → Phase 4.
- Exception-feed UI, RFID confidence heatmaps, animation → Phase 5.
</deferred>
