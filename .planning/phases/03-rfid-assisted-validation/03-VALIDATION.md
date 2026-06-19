---
phase: 3
slug: rfid-assisted-validation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-19
---

# Phase 3 — Validation Strategy

> `@mm/sensor-fusion` is pure → fast unit/property tests; detection + exceptions projection get integration tests. Derived from 03-RESEARCH.md "Validation Architecture". Gates include turbo `pnpm build`.

## Test Infrastructure
| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Quick run** | `pnpm test` (pure sensor-fusion unit/property — no DB) |
| **Full suite** | `pnpm test:all` (+ tag-registry/zone/exceptions integration + prior suites) |
| **Build gate** | `pnpm build` (turbo) MUST pass (Phase-2 lesson) |

## Per-Requirement Verification Map
| Requirement | Behavior to prove | Test Type | Command |
|-------------|-------------------|-----------|---------|
| SNS-01 | RFID/barcode ingested as confidence-scored evidence (RSSI→prob, capped), never coordinates | unit | `pnpm --filter @mm/sensor-fusion test` |
| SNS-02 | tagId→packageId registry from PackageCreated.rfidTagId | integration | `pnpm --filter @mm/projections test tag` |
| SNS-03 | Bayesian rear/middle/nose zone estimate; dwell-windowed; confidence never →1.0 | unit + property | `pnpm --filter @mm/sensor-fusion test fuse` |
| SNS-04 | Wrong-trailer: positive obs >threshold in unassigned trailer ⇒ exception {severity, action}; else none | unit + integration | `pnpm --filter @mm/sensor-fusion test wrong-trailer` |
| SNS-05 | Missed-unload: package for departed hub still observed post-departure ⇒ exception | unit + integration | `pnpm --filter @mm/sensor-fusion test missed-unload` |
| SIM-03 | Simulator emits probabilistic RFID (miss-rate + noise); same seed ⇒ identical stream | unit | `pnpm --filter @mm/simulation test rfid` |

## Keystone Tests (P6/P5b defense)
- [ ] **Anti-P6 (most important):** absence of RFID reads ⇒ ZERO exceptions, NEVER "missing"/vanished.
- [ ] **Anti-P6 threshold:** wrong-place obs below threshold ⇒ no exception; above ⇒ exactly one.
- [ ] **Anti-P5b cap:** N=100 repeated same-tag/same-dwell strong reads ⇒ fused confidence strictly <1.0 and ≤ ceiling (~0.85-derived), not asymptotic to 1.0.
- [ ] **Anti-P5b collapse:** N reads in one dwell window count as ONE observation packet.
- [ ] Detection/fusion separation: rule decisions never fed back into the likelihood engine.

## Wave 0 Requirements
- [ ] `packages/sensor-fusion` scaffolded (pure, import only @mm/domain), Vitest wired, downward-only deps.
- [ ] `@mm/domain`: add RfidObserved / WrongTrailerDetected / MissedUnloadDetected to the closed union + zod schemas + contract.assert (build-gate stays green).

## Manual-Only Verifications
| Behavior | Requirement | Why Manual | Instructions |
|----------|-------------|------------|--------------|
| Exception feed shows credible wrong-trailer/missed-unload alerts (no flood) on a noisy sim run | SNS-04/05 | Feed credibility/readability is subjective | Run a seeded noisy sim; hit `GET /exceptions`; confirm plausible alerts + recommended actions, low false-positive rate |

---
*Validation strategy for Phase 3 — keystones: absence≠missing (P6) and confidence-cap (P5b).*
