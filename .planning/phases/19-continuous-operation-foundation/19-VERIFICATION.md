---
phase: 19
name: Continuous Operation Foundation
status: passed
verified: 2026-06-24
gate: "pnpm check (lint+typecheck+test:all) — 166 files / 1737 tests passed, 0 failures"
---

# Phase 19 Verification — Continuous Operation Foundation

**Goal:** The simulation runs open-ended across multiple day/cycle periods with bounded memory and proven long-run determinism.

**Result: PASSED.** Built via rival worktrees (2 independent TDD implementations) → judge (winner `p19-r1`) → resumable-engine + bounded-retention hardening (per user directives) → adversarial determinism verifier (found + fixed a real HOS key-order break) → bounded test scale → exclusive clean gate.

## Requirements — all met
| Req | Status | Evidence |
|-----|--------|----------|
| CONT-01 open-ended run | ✅ | `runUntilStopped` opt-in; finite `durationTicks` path unchanged; `driveSimulationOpenEnded` runs past horizon, stops on signal (`open-ended-driver.int`). |
| CONT-02 sustained multi-cycle | ✅ | Self-rescheduling generation across cycles; continuation engine advances indefinitely. |
| CONT-03 sim-day/cycle counter | ✅ | `simDay` on `WsEnvelope` (derived from `occurredAt`), shown in operator UI (KpiDashboard). |
| CONT-04 bounded end-to-end (RAM+storage) | ✅ | Resumable `SimContinuation` (no prefix regen → bounded RAM, O(1)/chunk); watermark catch-up; ws `bufferedAmount` backpressure; optimizer idempotency `LruMap` (cap 500); **event-log prune below watermark + stale-projection age-out** on the opt-in continuous path (`retention.ts`, `retention.int`). |
| CONT-05 (P2) sort-wave | ✅ | Flag-gated burst-quiet-burst cadence; flag-off byte-identical. |
| DET-01 opt-in / flags-off byte-identical | ✅ | All features opt-in; seed-1234 + seed-42 goldens byte-identical with flags off; finite/test paths never pruned. |
| DET-02 long-run determinism | ✅ | seed-42 10k SHA-256 `3920accc05220b45f79736cc98c9773fa7ffd8df08eb607bdbed2b8c054d6861`; reproducible in-process; continuation-equivalence (chunked == all-at-once, byte-identical) across seeds×chunks×horizons + feature-flag combos; **HOS chunk-boundary regression at h≥1500**. |

## Determinism keystone — verified
- Existing finite `simulate()` path byte-identical (seed-1234 JSON-equality; seed-42 SHA-256 unchanged).
- Continuation engine produces byte-identical streams vs all-at-once (adversarially verified: RNG-substream completeness, phantom-state, pointer-identity, chunk-boundary edges).
- One real break found by the adversarial verifier (HOS clock JSON key-order across continuation boundaries) — root-caused and fixed by canonicalizing the clock at the single emit site (`canonicalHosClock`); values untouched; goldens unaffected (HOS off by default).

## Bounded storage (user directive "do not store all simulation data indefinitely")
- Event log pruned where `global_seq <= watermark - margin` (never ≥ watermark; catch-up resume is exclusive) — continuous-path only.
- Stale projection rows aged out beyond a retention horizon.
- Finite/test paths retain the full log → golden replay-from-0 intact.
- Pulled in from HRD-FUT-01 (snapshot-based crash-recovery + partitioning remain future).

## Notes / follow-ups
- Test scale was bounded for reliable gating (chunk-1×huge-horizon fuzzing + Postgres-bound continuous tests) without coverage loss; HOS regression retained.
- Gate hygiene learned: clear leftover vitest workers + testcontainers between runs; `--no-file-parallelism` + heap bump; never run competing gates concurrently (OOM).
- Google AI Mode consulted (udm=50) on continuous-DES determinism, bounded retention, and continuation design — endorsed the approach; net-new items folded into gates.

**Gate:** `pnpm check` → 166 files / 1737 tests passed, 0 failures (2026-06-24).
