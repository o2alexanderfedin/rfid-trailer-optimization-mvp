# Phase 3 (RFID-Assisted Validation) — Code Review Dispositions

Confirmed code-review fixes for Phase 3, implemented with TDD on
`feature/phase-3-rfid-assisted-validation`. Severity mix: 1×HIGH, 2×MEDIUM, 9×LOW.

| ID | Severity | Title | Disposition | Note |
|----|----------|-------|-------------|------|
| A | HIGH | RFID disabled on the runnable entrypoint — Phase 3 dark on the live demo | FIXED | `main.ts` called `driveSimulation` without `rfid`, so `driver.ts` gated the entire pipeline off (detection runs iff `rfid !== undefined`): zero reads, zero zone estimates, zero exceptions live. Added calibrated `DEMO_RFID_CONFIG` (`wrongZoneRate 0.10`, `missRate 0.05`, `antennaBurst 6`) in `detection-config.ts`, wired `main.ts` to pass it. Empirical sweep over the live path (seed 4242 / 120 ticks / `PRODUCTION_DETECTION_CONFIG`): 0.08→5, **0.10→9**, 0.12→8, 0.15→15, 0.20→17 wrong-trailer exceptions; 0.10 sits in the demo-credible 3–12 band. Pinned by `demo-feed.int.test.ts` (>= 3 wrong-trailer, queryable via `readOpenExceptions` + `GET /exceptions`). |
| B | LOW | `window.ts` `groupKey` id collision | FIXED | `groupKey` concatenated `tagId+readerId+dwellWindowId` with no delimiter (tag "AB"+reader "C" collided with tag "A"+reader "BC"). Joined with ASCII Unit Separator (U+001F). Unit tests pin two naive-concat-colliding tuples to distinct keys. |
| C | LOW | Wrong-trailer `exceptionId` drops escalation | FIXED | Dedupe id omitted `plannedTrailerId` (passed `null`), so a re-plan onto a different trailer (escalated severity/action) while still observed on the same wrong trailer collided and was dropped. Now both the detector dedupe key (`detector.ts`) and the reducer row key (`exceptions.ts`) fold `plannedTrailerId` in. Unit test pins distinct ids for same (pkg, observedTrailer) / different plannedTrailer. |
| D | MEDIUM | Confidence-cap keystone bound too loose | FIXED | Composite bounds passed even if ONE of the two anti-P5b defenses was removed (the surviving guard kept conf under ceiling). Added two isolating pins: per-read cap (entropyFloor disabled ⇒ only the 0.85 cap bounds conf) and entropy floor (maxLikelihood=1.0 ⇒ only the floor bounds conf, pinned at exactly (1-floor)+floor/3). Each verified to FAIL under its OWN mutant while the other passes. Test-only. |
| E | LOW | Anti-P6 keystone near-tautological | FIXED | The "no missing marker" assertion string-grepped output for literals the candidate shape can never contain — could not fail. Replaced with the real invariant driven through the actual `windowObservations`+`fuseZone` pipeline: a package WITH reads fires; packages with ZERO reads appear nowhere; plus an empty-observed control. Verified to FAIL when detection is mutated to be plan-driven (absence-as-missing). Test-only. |
| 1 | MEDIUM | SNS-05 missed-unload never fires on the live sim path | DEFERRED-P5 | Out of scope this round. Requires over-carry + return-leg modeling — specifically `TrailerDeparted(fromHubId=spoke)` on the return leg so a still-aboard package destined for a departed spoke can be detected post-departure. Needs changes to `simulation/src/engine.ts` trip model (explicitly not touched). The detector core + post-departure gate already support it via the `readDepartedHubs` port (DIP), so this tightens with zero detector change once the sim emits the return-leg departures. Confirmed on the live calibration sweep: `missed-unload` = 0 across all `wrongZoneRate` values. |
| 2 | LOW | Sim corruption-path / live `missed-unload` assertions absent | CARRIED-LOW-DEBT | Coupled to finding [1]; once SNS-05 fires on the live path (Phase 5) add live assertions for the missed-unload feed. No code change now. |
| 6 | LOW | `asDistribution` zero-fill in `detector.ts` | CARRIED-LOW-DEBT | `asDistribution` fills absent zone keys with 0; harmless for current projection rows (always full distributions). Documented debt; revisit if partial posteriors ever persist. |
| 8 | LOW | Golden-replay exceptions coverage | CARRIED-LOW-DEBT | The golden-replay keystone does not yet assert the exceptions feed/KPI. Detection determinism is covered by `exceptions.int.test.ts` (e) re-run-same-seed. Documented debt. |
| 10 | LOW | engine↔detector calibration contract | CARRIED-LOW-DEBT | The fusion saturation band (~0.33–0.40) and the production detection thresholds are co-calibrated by comment + the int suites, not by an explicit shared-contract test. Documented debt. |
| 11 | LOW | `makeProjectionReads` FP-risk | CARRIED-LOW-DEBT | `readDepartedHubs` in `makeProjectionReads` infers departed hubs from in-transit trailers' still-aboard package destinations (a pragmatic MVP gate); the live driver already overrides it with the EXACT `TrailerDeparted.fromHubId` set. Documented debt; the override is the production path. |

## Summary

- **FIXED:** A, B, C, D, E (5).
- **DEFERRED-P5:** 1 (1) — needs over-carry + return-leg `TrailerDeparted(fromHubId=spoke)` trip modeling.
- **CARRIED-LOW-DEBT:** 2, 6, 8, 10, 11 (5).

## Gate (final)

- Build: `pnpm build` — 9/9 tasks successful.
- Tests: `pnpm test:all` — 58 files, 463 tests, all passing (golden-replay keystone intact).
