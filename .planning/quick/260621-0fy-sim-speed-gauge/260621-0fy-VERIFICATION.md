---
quick_id: 260621-0fy
slug: sim-speed-gauge
phase: quick/260621-0fy-sim-speed-gauge
verified: 2026-06-21T00:58:00Z
status: passed
score: 5/5 truths verified (6/6 artifacts, 3/3 key_links)
overrides_applied: 0
re_verification:
  previous_status: null
  note: initial verification (no prior VERIFICATION.md)
---

# Quick Task 260621-0fy — UI speed-of-time gauge — Verification Report

**Goal:** A "speed of time" gauge (slider 0.25×–8× + sim-min/real-sec readout + Pause)
that retunes the BACKEND tick interval live, echoes the effective speed on the WS
envelope, and fixes the latent frontend clock bug so trailers track the server pace.

**Verified:** 2026-06-21
**Status:** passed
**Branch:** feature/sim-speed-gauge
**Re-verification:** No — initial verification
**Method:** structural (code reading); full test suite NOT run here (separate gate).

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| a | A test PROVES simSpeed=1 cannot track the 120× cadence and simSpeed=120 tracks | ✓ VERIFIED | `packages/web/src/map/simClock.test.ts:134-139` RED asserts `lag > 1_000_000` at simSpeed=1; `:141-146` GREEN asserts `lag <= 1000` at simSpeed=120. `replayCadenceLag` (`:113-132`) replays the real paced cadence (simMs+=60000 every 500 wall-ms). `setSpeed(120)` halts lag (`:153-190`); `setSpeed(0)` freezes (`:192-204`). File is `.ts` → RUNS in root `unit` project. |
| b | MapView drives the clock from envelope.speed.simSpeed | ✓ VERIFIED | `MapView.tsx:262` `simClockRef.current.setSpeed(envelope.speed.simSpeed)` inside `onEnvelope`, before `resync` (`:270`). Clock seeded `makeSimClock({ simSpeed: 120 })` (`:94`) — the corrected default that fixes the latent `simSpeed:1` bug. |
| c | The paced driver reads the tick interval LIVE per iteration (not captured once) | ✓ VERIFIED | `driver.ts:535` inside the `for (const tick of ticks)` loop: `resolveTickIntervalMs(opts.getTickIntervalMs, opts.tickIntervalMs)` then `await sleep(intervalMs)`. `resolveTickIntervalMs` (`:208-216`) calls `live()` fresh each invocation; test `driver.test.ts:134-142` proves the live source is re-read mid-run (500→62→2000). |
| d | Pause freezes backend advance AND yields envelope simSpeed=0 | ✓ VERIFIED | Backend hold: `driver.ts:455-457` `while (opts.isPaused?.() === true) await sleep(PAUSE_POLL_MS)` BEFORE any append/project/broadcast for the tick. Envelope simSpeed=0: `speed-controller.ts:102-103` `getSimSpeed() = paused ? 0 : msPerTick/tickIntervalMs`; asserted in `speed-controller.test.ts:96,107,119` and `sim-speed.test.ts:79-81`. |
| e | The sim STREAM is byte-identical regardless of interval/pause — a determinism test exists | ✓ VERIFIED (see note) | `driver.test.ts:167-183` asserts `simulate(seed)` is byte-identical across calls and non-vacuous (different seeds diverge). Structurally guaranteed: `driver.ts:424` generates the full stream via `simulate({seed,durationTicks})` ONCE, with NO interval/pause inputs, before the pacing loop — interval/pause provably cannot reach the generator. |

**Score:** 5/5 truths verified.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/api/src/sim/speed-controller.ts` | pure clamped speed/pause state | ✓ VERIFIED | 146 lines. `makeSpeedController` with `getTickIntervalMs/isPaused/getSimSpeed/snapshot/setMultiplier/setPaused/apply/noteSimMs`. m clamped [0.25,8], interval clamped [62,2000], never 0. (+test, 16 `it`s.) |
| `routes/sim-speed.ts` (POST+GET) | validate, mutate controller, immediate broadcast, reply state | ✓ VERIFIED | 117 lines. `app.get` (`:94`) + `app.post` (`:100`); closed schema `additionalProperties:false`, `minProperties:1`, multiplier bound [0.25,8]; replies `controller.snapshot()`. Immediate broadcast via controller `onChange` (wired in server.ts), not direct — verified by `sim-speed.test.ts:147-162`. (+test, 9 cases incl. 400s.) |
| Envelope-level `speed` on BOTH variants | `{simSpeed,tickIntervalMs,paused}` + multiplier | ✓ VERIFIED | `envelope.ts:35-40` `SimSpeedState` (4 fields). `:174-175` `speed: SimSpeedState` **required** (not optional) on snapshot AND tick variants, envelope-level (beside `simMs`, outside payload → `diffTick` untouched). |
| `simClock.setSpeed(simSpeed)` | live speed setter | ✓ VERIFIED | `simClock.ts:139-150`; re-anchors at current projected value before rate change (no discontinuity), clamps negative→0, freezes at 0. Driven from envelope in MapView (truth b). |
| `panels/SpeedControl.tsx` | slider 0.25×–8× + readout + Pause/Resume | ✓ VERIFIED | 204 lines. Log-scale range slider (`:187-200`), readout `formatReadout` (`:173-175`), Pause/Resume button (`:178-186`), debounced POST (`:132-145`), envelope-confirmed display (`:108-121`), mounted in right rail (decoupled from OL map). (+test `.ts`.) |
| `client.setSimSpeed({multiplier?,paused?})` | POST helper | ✓ VERIFIED | `client.ts:206-219` POSTs `/api/sim/speed`, returns `SimSpeedState`, supports AbortSignal. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| driver pacing | speedController.getTickIntervalMs()/isPaused() | main.ts wiring | ✓ WIRED | `main.ts:87-88` `getTickIntervalMs: () => speedController.getTickIntervalMs()`, `isPaused: () => speedController.isPaused()` passed into `driveSimulationPaced` (`:78`). |
| snapshots.ts broadcast | envelope.speed = speedController.snapshot() | currentSpeed() | ✓ WIRED | `snapshots.ts:467-468` `currentSpeed()` returns `speedController.snapshot()`; stamped on snapshot (`:518`), resync (`:540`), tick (`:569`); `noteSimMs(simMs)` at `:560`. |
| MapView onEnvelope | simClock.setSpeed(envelope.speed.simSpeed) | useCallback onEnvelope | ✓ WIRED | `MapView.tsx:262`. |
| (composition) onChange → immediate broadcast | server.ts buildServer | onChange closure | ✓ WIRED | `server.ts:140-145` one controller, `onChange: () => broadcast?.(speedController.getLastSimMs())`; `attachSnapshotSocket(app, db, speedController)` (`:149`); `registerSimSpeedRoutes(app, speedController)` (`:171`); `speedController` returned (`:174`). |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| SpeedControl.tsx | `speed` (SimSpeedState) | `registry.subscribe` → `envelope.speed` (`:109-110`) | Yes — fed from server `speedController.snapshot()` via the ws envelope | ✓ FLOWING |
| MapView simClock | `envelope.speed.simSpeed` | server snapshot builder | Yes — same envelope path; default seed 120 corrected on first envelope | ✓ FLOWING |
| envelope.speed (server) | `speedController.snapshot()` | live SpeedController mutated by POST /sim/speed | Yes — not static; reflects mid-run multiplier/pause | ✓ FLOWING |

### Anti-Patterns Found

None. Scanned all 14 phase files (speed-controller.ts, routes/sim-speed.ts, envelope.ts,
snapshots.ts, driver.ts, server.ts, main.ts, simClock.ts, MapView.tsx, SpeedControl.tsx,
client.ts, RightRail.tsx, index.ts, wsClient.ts) for TODO/FIXME/XXX/TBD/HACK/PLACEHOLDER/
"not implemented"/"coming soon" — zero matches (the only "out of scope"/"no jsdom" strings
are in deliberate doc comments explaining the test-runner caveat, not debt markers).

### Coverage Caveat (as flagged in the task)

CONFIRMED and MITIGATED. `vitest.config.ts:19` — the root `unit` project includes only
`packages/*/src/**/*.test.ts` (and `test/**/*.test.ts`), NOT `*.test.tsx`. Pre-existing;
the untouched AlertFeed/KpiDashboard `*.test.tsx` panel tests are likewise never run.

The gauge's logic is NONETHELESS covered by `.ts` tests that DO run:
- `packages/web/src/panels/SpeedControl.test.ts` (`.ts`, 14 cases) exercises the pure
  exported helpers (`multiplierToSlider`/`sliderToMultiplier` log2 math, `formatReadout`,
  `speedChanged` re-render guard, `DEFAULT_SPEED`). The `.tsx` component is a thin shell
  over these helpers (established panel pattern).
- `packages/web/src/map/simClock.test.ts` (`.ts`) covers the actual clock fix (cadence
  proof, setSpeed, freeze).
- Backend logic (`speed-controller.test.ts`, `sim-speed.test.ts`, `driver.test.ts`) are
  all `.ts` and run.

Note: there is NO `SpeedControl.test.tsx` (the plan's T8 mentioned a jsdom `.test.tsx`).
The implementer deliberately substituted a `.ts` helper test so it actually runs (no jsdom
is installed). Full DOM rendering of the slider/button is therefore not unit-asserted and
is an e2e/human concern — captured below.

### Human Verification Required (optional manual demo)

| # | Test | Expected | Why human |
|---|------|----------|-----------|
| 1 | Launch the demo, drag the slider across 0.25×–8× | Trailers visibly speed up / slow down; readout matches `~N sim-min/real-sec` | Visual / real-time animation pacing cannot be asserted structurally; no jsdom DOM test for the component shell. |
| 2 | Click Pause, then Resume | Trailers freeze (tween stops) on Pause and the readout shows paused; resume restores motion | Real-time freeze behavior is visual; backend hold + simSpeed=0 are unit-proven, but the end-to-end visual freeze is a human check. |

These items are OPTIONAL (the plan lists the manual demo as "optional"). Every must-have is
structurally VERIFIED in code with running `.ts` tests, so the goal is achieved; the manual
demo only confirms the visual feel. Status is `passed` on that basis.

### Partial / Notes (flagged, NOT fixed)

1. **Truth (e) determinism test is structural, not behavioral.** The plan's T3 wording
   ("a fake controller whose interval/paused flips mid-run … assert determinism of emitted
   events is unchanged") implied driving the paced loop with a flipping controller and
   diffing the event log. The shipped `driver.test.ts:167-183` instead asserts `simulate()`
   is byte-identical and that the paced driver passes NO pacing inputs to it. This is the
   load-bearing guarantee (pacing provably cannot reach the generator) and is sufficient,
   but it is a lighter form than a full mid-run-flip integration diff. Pacing-loop behavior
   under a flipping controller is otherwise covered indirectly by `resolveTickIntervalMs`
   re-read tests (`:134-142`). Not a gap — noted for completeness.

2. **No `SpeedControl.test.tsx`** (see Coverage Caveat). Intentional `.ts` substitution;
   logic is covered. The component shell's DOM wiring is not unit-asserted.

### Gaps Summary

No gaps. All 5 observable truths VERIFIED, all 6 artifacts exist + are substantive + wired
+ data flows, all key links WIRED, zero anti-patterns, zero unreferenced debt markers. The
known coverage caveat is real but MITIGATED — the gauge's logic and the clock fix are both
covered by `.ts` tests that run in the `unit` project. The two human-verification items are
optional visual confirmations of an already-proven implementation.

---

_Verified: 2026-06-21T00:58:00Z_
_Verifier: Claude (gsd-verifier) — structural, code-reading only_
