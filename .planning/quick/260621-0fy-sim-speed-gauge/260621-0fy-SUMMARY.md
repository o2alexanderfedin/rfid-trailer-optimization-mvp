---
quick_id: 260621-0fy
slug: sim-speed-gauge
title: UI speed-of-time gauge (live sim-speed control + clock fix)
status: complete
created: 2026-06-21
completed: 2026-06-21
mode: quick
---

# Quick Task 260621-0fy — UI speed-of-time gauge — SUMMARY

A live "speed of time" gauge (slider 0.25×–8× of the default + sim-min/real-sec
readout + Pause/Resume) that actually changes how fast trailers move, by making
the **backend tick interval live-tunable**, **echoing the effective speed on the
ws envelope**, and **fixing the latent frontend clock bug** (`simSpeed:1` could
not track the 120× server cadence).

## Outcome

All 8 must-haves satisfied. Default behavior at 1× is unchanged. Determinism of
the sim STREAM is preserved (interval/pause are presentation pacing only — never
fed to `simulate`/event store/optimizer).

## Commits (feature/sim-speed-gauge)

| Hash | Subject |
|------|---------|
| `8fe00fc` | test(web): prove simSpeed=1 cannot track 120x cadence; add simClock.setSpeed |
| `668b1de` | feat(api): pure SpeedController (multiplier<->tickInterval, pause) |
| `eb179b0` | feat(api): driveSimulationPaced reads live tick interval + honors pause |
| `91fe716` | feat(api): echo effective sim speed on the ws envelope |
| `324cc7a` | feat(api): POST /api/sim/speed control endpoint |
| `405bc07` | feat(api): wire SpeedController through driver/broadcast/route |
| `2530083` | fix(web): drive sim clock speed from the envelope (trailers track server pace) |
| `1154ddd` | feat(web): sim-speed gauge (slider 0.25x-8x + pause) |

## Files created

- `packages/api/src/sim/speed-controller.ts` — pure clamped speed/pause state.
- `packages/api/src/sim/speed-controller.test.ts`
- `packages/api/src/routes/sim-speed.ts` — GET/POST /sim/speed.
- `packages/api/src/routes/sim-speed.test.ts`
- `packages/web/src/panels/SpeedControl.tsx` — the gauge.
- `packages/web/src/panels/SpeedControl.test.ts` — pure-helper tests.

## Files changed

- `packages/api/src/ws/envelope.ts` — `SimSpeedState` contract + required
  envelope-level `speed` on both WsEnvelope variants.
- `packages/api/src/ws/snapshots.ts` — `attachSnapshotSocket(app, db,
  speedController, options?)`; stamps `speed` + calls `noteSimMs`.
- `packages/api/src/ws/snapshots.test.ts`, `packages/api/test/ws-rejection.test.ts`
  — controller injection + speed assertions.
- `packages/api/src/sim/driver.ts` — `getTickIntervalMs?`/`isPaused?`, live
  interval read + pause hold; `resolveTickIntervalMs` helper.
- `packages/api/src/sim/driver.test.ts` — live-interval + stream-determinism tests.
- `packages/api/src/server.ts` — one SpeedController (onChange → immediate
  broadcast), route registration, returned from buildServer.
- `packages/api/src/main.ts` — pass getTickIntervalMs/isPaused to the paced driver.
- `packages/api/src/index.ts` — export SimSpeedState, SpeedController, route.
- `packages/web/src/map/simClock.ts` — `setSpeed(simSpeed)` (re-anchor, clamp >=0,
  freeze on 0).
- `packages/web/src/map/simClock.test.ts` — cadence/setSpeed/freeze tests.
- `packages/web/src/map/MapView.tsx` — seed simSpeed=120; setSpeed from envelope.
- `packages/web/src/map/wsClient.ts` — parseEnvelope validates `speed`.
- `packages/web/src/map/wsClient.test.ts`, `WsProvider.test.ts`,
  `panels/KpiDashboard.test.tsx` — envelope literals carry `speed`.
- `packages/web/src/api/client.ts` — `setSimSpeed({multiplier?,paused?})`.
- `packages/web/src/panels/RightRail.tsx` — mount SpeedControl.
- `packages/web/src/index.css` — `.speed-control` styles.

## T1 numbers (the latent clock bug, proven)

Replaying the real paced cadence (resync every 500 wall-ms with simMs += 60000):

- `simSpeed=1` lags the server by **1,770,500 sim-ms** (~29.5 sim-minutes) after
  30 ticks — the nudge clamp recovers at most ~1000 sim-ms/tick.
- `simSpeed=120` tracks with **0 lag** (500 wall-ms × 120 = 60000 == server jump).
- `setSpeed(120)` halts the unbounded lag growth; `setSpeed(0)` freezes the clock.

## Gates

| Gate | Result |
|------|--------|
| `pnpm lint` (monorepo) | 0 errors |
| `pnpm typecheck` (monorepo) | 0 errors |
| api unit (`vitest run --project unit packages/api`) | 16 files, **197 passed** |
| web unit (`vitest run --project unit packages/web`) | 6 files, **94 passed** |

## Notes / needs attention

- **Test runner naming quirk (pre-existing):** the root vitest `unit` project only
  includes `*.test.ts`, NOT `*.test.tsx` — so every existing `*.test.tsx` panel
  test (AlertFeed, KpiDashboard, etc.) is never executed by vitest. To make the
  gauge's tests actually RUN, `SpeedControl.test.ts` is a `.ts` file testing pure
  exported helpers (the established panel pattern: KpiDashboard logic lives in
  pure helpers, the component is a thin shell). No jsdom/testing-library is
  installed; adding one was out of scope. The component is exercised at the
  logic level (slider math, readout string, envelope-speed change guard, pause
  input) — full DOM rendering remains an e2e concern.
- **`pnpm --filter <pkg> test` fails repo-wide (pre-existing):** running `vitest run`
  from a package subdir can't resolve the root config's `packages/*/...` include
  globs (reproduced on the untouched `@mm/optimizer`). Use root
  `vitest run --project unit` (green). Not introduced by this task.
- Integration tests (`*.int.test.ts`) typecheck and need no literal changes
  (they parse envelopes from the wire); run via `pnpm test:all` (operator runs it).
