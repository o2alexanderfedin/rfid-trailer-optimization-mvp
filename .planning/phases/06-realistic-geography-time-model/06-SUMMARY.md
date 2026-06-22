# Phase 6: Realistic Geography & Time Model — Summary

**Completed:** 2026-06-21 · **Branch:** `feature/v1.1-realistic-time-model` · **Status:** ✅ COMPLETE & verified — all criteria met, including VIZ-06 real road polylines (ORS key provided; precomputed + committed).

## What was delivered

| REQ | Status | Notes |
|-----|--------|-------|
| **OPT-10 foundation** (enabling infra) | ✅ Done | `LogNormalParams`/`TimingConfig`/`DEFAULT_TIMING_CONFIG` moved to `@mm/domain` + pure `expectedMinutes(p)=clamp(median·exp(σ²/2),min,max)` (log-normal MEAN). `@mm/simulation` re-imports (DRY); `sampleLogNormal` unchanged. (`cd2b5c8`) |
| **TIME-02** | ✅ Done | Distinct center re-dispatch dwell at turnaround — `dwellCenter` (≈65 min) now fires; spoke uses `dwellSpoke`; exactly one dwell per stop (no double-count). Seeded/deterministic. (`86c28b1`) |
| **TIME-01** | ✅ Done | Per-leg transit median derived from real great-circle (haversine) distance @ 80 km/h HGV — long legs proportionally longer. DIP override: explicit `timing` config → flat transit. (`5d653cd`) |
| **VIZ-06** | ✅ Done | Loader + great-circle fallback + `scripts/precompute-routes.ts` (`179f960`). **Finalized (`e0aae29`):** ORS key provided → precomputed real `driving-hgv` polylines, **RDP-simplified 8.5 MB → 82 KB** (~72 pts/leg), committed `road-geometry.generated.json` (now the default; great-circle = fallback-when-absent, drift-guarded by hub checksum). Per-leg ORS `duration_s` also became the transit median on both the simulator and optimizer (TIME-01 upgrade), so the displayed roads and the planned times are consistent end-to-end. Caught + fixed a real build gap (`tsc` doesn't emit data files → added a `copy-assets` step so built `@mm/api` resolves the JSON). |

## Verification (independently re-run by the orchestrator)

- `pnpm build` 10/10 · `pnpm typecheck` 0 · `pnpm lint` 0
- **Unit: 918 passed** (incl. 8 new `expectedMinutes` tests + per-leg-transit + center-dwell + road-geometry-loader tests, TDD red→green)
- **Integration: 82 passed / 20 files** (incl. the `scenario-reopt` keystone + `projections-golden-replay` determinism keystone)
- Determinism contract preserved (same seed + config ⇒ byte-identical).

## Key decisions

- **Deterministic planning estimate = log-normal MEAN** (`median·exp(σ²/2)`), not median (optimistic) or percentile (over-conservative) — OPT-10. Single shared `expectedMinutes` in `@mm/domain` so sim draw + planner estimate share one source of truth.
- **Transit scale = realistic-absolute** (haversine @ 80 km/h ⇒ ~400–2250 min/leg), kept as the **default** because the milestone goal is a *defensible* time model; the 120× sim-speed gauge handles demo watchability. Lifecycle integration tests opt into flat ~30-min transit via the engine's existing `timing` DIP override (threaded through `driver.ts`/`sim-controller.ts`/`server.ts`); transit realism itself is unit-tested. (`3bf463f`)
  - *Reversible alternative if the demo should stay snappy by default:* distance-**proportional-compressed** (anchor a typical leg to ~30 min) — a localized formula change in `routes.ts`.

## Deferred / follow-ups

- ✅ **VIZ-06 road data — DONE** (`e0aae29`): ORS key provided; real `driving-hgv` polylines precomputed + RDP-simplified (82 KB) + committed; transit medians switched from haversine to ORS `duration_s`. The `.env` holds the key (gitignored) to regenerate via `scripts/precompute-routes.ts` if hubs change (a `hubChecksum` drift guard flags staleness).
- **Integration suite runtime** ballooned (~350s → ~1600s) under realistic-timing horizons; a CI-time optimization (more flat-timing pins or shorter horizons) is a candidate cleanup.
- One re-baseline: `demo-feed.int.test.ts` `MIN_WRONG_TRAILER` 3→1 (TIME-02's longer turnaround ⇒ fewer round trips / spoke reads in a 120-tick window) — assertion intent preserved.

## Process note

The first build pass (a 6-agent workflow) implemented all three requirements with green *unit* gates, but its adversarial determinism auditor returned a **false PASS** — it cited a stale pre-change commit as the keystone re-baseline. An independent integration run (the unit lane never runs the keystones) exposed **12 failures / 6 files**, which were then fixed and re-verified to green. Lesson: integration/determinism keystones must be run, not audited (PITFALLS P6).

## Commits

`cd2b5c8` (foundation) · `86c28b1` (TIME-02) · `5d653cd` (TIME-01) · `179f960` (VIZ-06 infra) · `3bf463f` (integration fix).
