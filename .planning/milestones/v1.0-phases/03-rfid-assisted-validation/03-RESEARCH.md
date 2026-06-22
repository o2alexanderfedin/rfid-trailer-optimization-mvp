# Phase 3 Research: RFID-Assisted Validation

**Researched:** 2026-06-19
**Phase:** 3 — RFID-Assisted Validation
**Requirements:** SNS-01..05, SIM-03
**Sources:** tech spec §8 (sensor model), §17 (exceptions), §22 Risk-1; project PITFALLS (P5b, P6); Phase 1-2 code; and a **Google AI Mode browser consult** (mandatory) on rule-based Bayesian RFID/RSSI fusion + overconfidence avoidance.

---

## Google AI Mode Consult (2026-06-19)

Query: rule-based Bayesian sensor fusion, RFID RSSI confidence, independence cap, dwell window, avoid overconfidence. The answer gave concrete, adopt-now techniques:

- **Conditional-independence violation:** RFID RSSI badly violates the Bayesian independence assumption (multipath/interference). Treating dependent reads as independent causes overconfident lock-on — exactly P5b.
- **Downsample sequential reads:** a burst of N reads from the same antenna in one window is ONE aggregated observation packet, NOT N Bayesian updates. → our dwell windowing.
- **Likelihood cap ≤ 0.85:** never let a single strong RSSI yield P=1.0; cap max sensor likelihood (P(RSSI|Zone) ≤ ~0.85) so one outlier can't hijack the posterior. → our confidence cap, concrete value.
- **Sliding aggregation window (2–3s):** use the 90th-percentile RSSI or mode (NOT mean — multipath drops skew the mean); factor **read-rate density** (high RSSI w/ 1 read < moderate RSSI w/ 40 reads) into confidence.
- **RSSI hysteresis boundaries:** overlapping enter/exit thresholds (e.g. enter −55 dBm, exit −65 dBm) to stop boundary chatter.
- **Physical transition constraints (Markov prior):** a zone transition matrix; near-zero prior for impossible jumps (rear→nose without passing middle).
- **Noise floor / entropy insertion:** blend 1–5% uniform uncertainty into the posterior each step → never 100% certain; recovers quickly when the asset moves.
- **Separate detection from tracking:** rule logic is a PRE-filter (gate noise/validate antenna health) or POST-filter (business rules) — do NOT feed rule decisions back into the Bayesian likelihood engine. → our two-layer planned-vs-observed design (P6).

**Adopt:** likelihood cap (default 0.85), per-dwell aggregation (90th-pct RSSI + read-rate density), hysteresis enter/exit, Markov zone-transition prior, 1–5% entropy floor, and strict detection/fusion separation. All deterministic + config-driven.

---

## Implementation Guidance

### `@mm/sensor-fusion` (PURE — import only @mm/domain)
- `rssiToLikelihood(rssi, readerType, config)`: monotonic; reader/antenna-type priors (dock portal high-reliability; trailer antenna zone-ish); output a per-read likelihood **capped at `maxLikelihood` (default 0.85)**.
- `windowObservations(reads, config)`: collapse reads keyed (tagId, readerId, dwellWindow) into ONE aggregated observation — use 90th-percentile (or mode) RSSI + read count (read-rate density). Anti-P5b: the aggregate's confidence is bounded; N repeats never → 1.0.
- `fuseZone(prior, windowedObs[], config)`: rule-based Bayesian posterior over {rear, middle, nose}; apply the Markov zone-transition prior; blend an entropy floor (1–5%) each step so the posterior never hits 1.0. Output `{ estimatedZone, confidence, lastReliableCheckpoint, lastObservedAt }` (spec §8.4).
- Detection predicates (PURE, separate from fusion): `detectWrongTrailer(planned, observed, config)` and `detectMissedUnload(planned, observed, departedHub, config)` — operate on the PLANNED (known) vs OBSERVED layers; emit a candidate exception ONLY on positive disagreement above `confidenceThreshold`. **Absence of an observation returns NOTHING (never "missing").**

### Domain events (extend the CLOSED union — contract.assert enforces exhaustiveness)
- `RfidObserved { tagId, readerId, antennaId, rssi, trailerId, hubId, confidence, occurredAt, schemaVersion }`.
- `WrongTrailerDetected { packageId, observedTrailerId, plannedTrailerId, confidence, severity, recommendedAction, occurredAt, schemaVersion }`.
- `MissedUnloadDetected { packageId, trailerId, hubId, confidence, severity, recommendedAction, occurredAt, schemaVersion }`.
- Add zod schemas + union members + update contract.assert.ts (the build-gate forces complete handling — the correct way to grow the union).

### Projections (`@mm/projections`, inline = decision-critical)
- Tag registry: `tagId → packageId` from PackageCreated.rfidTagId (SNS-02).
- Zone-estimate read model: latest fused estimate per (packageId, trailerId).
- Exceptions read model (INLINE, read-your-writes): current open exceptions from WrongTrailerDetected/MissedUnloadDetected; plus a false-positive-rate KPI counter.

### Simulation (`@mm/simulation`, SIM-03)
- Extend the seeded engine to emit RfidObserved at dock-door portals (on dock/load) and trailer antennas (during dwell) with configurable `missRate` (drop reads), `rssiNoise` (jitter), and a small `wrongTagRate`/`wrongZoneRate`. Same seed ⇒ identical RFID stream (drops + noise included). No real hardware.

### API (`@mm/api`)
- `GET /exceptions` (the exception feed: severity + recommendedAction) and per-package/per-trailer zone estimates; expose the **false-positive-rate** KPI. Reuse Phase-1 query conventions + the M-5 ws-rejection safety.

### Detector wiring
- The detector consumes PLANNED (Phase-2 plan/assignment + scans) + OBSERVED (fused zone/trailer estimate); on positive above-threshold disagreement it appends WrongTrailerDetected / MissedUnloadDetected; the inline exceptions projection surfaces them. Detection is gated post-departure for missed-unload (after TrailerDeparted).

---

## Validation Architecture

### Anti-P6 keystone (the most important Phase-3 test)
- **Absence ≠ missing:** a stream with packages that simply get NO RFID reads produces ZERO exceptions and NEVER marks a package missing/vanished. Assert no WrongTrailer/MissedUnload/"missing" is emitted purely from absence.
- **Threshold gating:** a positive wrong-place observation BELOW the confidence threshold ⇒ no exception; ABOVE ⇒ exactly one exception with severity + recommendedAction.

### Anti-P5b keystone
- **Confidence cap:** feeding N (e.g. 100) repeated same-tag/same-dwell strong reads yields a fused confidence that is STRICTLY < 1.0 and ≤ the configured ceiling (≈0.85-derived) — monotonic but bounded; never asymptotes to 1.0.
- **Dwell collapse:** N reads in one window count as ONE observation packet (assert the update count / posterior shift is bounded vs N independent updates).

### Detection truth tables
- Wrong-trailer (SNS-04): positive obs in unassigned trailer above threshold ⇒ exception; correct trailer ⇒ none; below threshold ⇒ none.
- Missed-unload (SNS-05): package for the departed hub still observed post-TrailerDeparted ⇒ exception; unloaded (no longer observed) ⇒ none; before departure ⇒ none.
- Severity + recommendedAction present and threshold/SLA-derived.

### Fusion correctness
- `rssiToLikelihood` monotonic in RSSI and capped; hysteresis prevents flapping across the enter/exit band; Markov prior zeroes impossible jumps; entropy floor keeps posterior < 1.0.

### Sim determinism (SIM-03)
- Same seed ⇒ identical RFID stream incl. drops/noise; missRate/noise honored (a 0 missRate ⇒ all reads; high missRate ⇒ many drops, still no false "missing").

### Purity / determinism
- `@mm/sensor-fusion` imports only @mm/domain; no Date.now()/Math.random() (seeded/explicit time); same input ⇒ same output. Gates include turbo `pnpm build`.

---

## Pitfalls Carried Into Plans
- **P6 RFID-as-truth** → two layers (planned vs confidence-scored observed); exceptions only on above-threshold disagreement; ABSENCE never implies missing; detection separated from the fusion likelihood engine.
- **P5b double-counted observations** → per-tag/per-reader/per-dwell windowing + likelihood cap (0.85) + entropy floor; N repeats never → 1.0.
- **Bad data quality (spec Risk-1)** → confidence scoring + conservative thresholds + false-positive-rate KPI so the feed isn't flooded.

---
*Phase 3 research — incorporates mandatory Google AI Mode consult on rule-based Bayesian RFID/RSSI fusion.*
