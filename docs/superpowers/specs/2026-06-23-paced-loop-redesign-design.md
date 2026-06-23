# Paced-Loop Redesign — Design Spec

**Date:** 2026-06-23
**Status:** Approved (brainstorming) → ready for implementation planning
**Milestone target:** v1.3 (paced-loop + demo realism)
**Author:** Claude (Opus 4.8) with o2alexanderfedin

---

## 1. Problem

The live demo plays a **pre-computed, deterministic** event stream (`simulate()` produces all ~120 ticks up front, seeded). A "paced driver" (`packages/api/src/sim/driver.ts`) delivers **one pre-baked tick per `setTimeout(tickIntervalMs)`**. The sim-speed control (0.25×–64×) only **shrinks that wall-clock interval**: `tickIntervalMs = 500 / multiplier`, floored at 5 ms.

Consequences (the bug, per commit `2b7373d`):

- At 64× the interval is ~8 ms, but the **per-tick work does not shrink** — each tick still does a DB append + projection rebuild + WS broadcast, and periodically a **synchronous, blocking optimizer run** (min-cost-flow + VRPTW). The sim-loop becomes sim-loop-bound; the clock crawls/freezes with >~9 trucks.
- `MS_PER_TICK` is fixed at 60,000 ms (1 sim-minute/tick), so speed never changes *how much sim-time advances per tick* — only how fast ticks are delivered. This is the coupling we must invert.

**Root cause:** tick **cadence** is coupled to **speed**, and the optimizer **blocks** the delivery loop.

### Confirmed via research (Google AI Mode, unbiased consult)
- **Accumulator pattern** is the standard fix: fixed wall-clock cadence; advance `simClock += wallDelta × speed`; drain all events with timestamp ≤ `simClock`. Avoid `setInterval` (drift) — chain `setTimeout`/`setImmediate` with a measured delta. Add a **max-events-per-tick budget** to prevent event-loop starvation at high speed.
- **Optimizer throttling must map to the *simulated* timeline, never wall-clock.** A wall-clock debounce is "banned" for deterministic, event-sourced systems (a slow machine would re-optimize less often in sim-time, mutating history and breaking replay). Sim-time-scheduled or event-driven (dirty-flag) triggers are deterministic.

---

## 2. Decisions (locked with user)

| Decision | Choice |
|----------|--------|
| Scope | Accumulator pacer (A) **+** worker-thread optimizer (B) |
| Plan timing | **Best-effort live** — plan *contents* deterministic for a given input; the live *moment* a new plan appears may vary run-to-run. The simulation event stream remains byte-deterministic. |
| Strict backpressure-stall / replay of plan-apply timing | **No** (follows from best-effort). |
| Client interpolation changes | **No** (client already tweens between diffs). |
| Generator time-slicing | **No** (worker thread chosen instead). |

**Reconciliation note:** the user picked "full worker pipeline" *and* "best-effort." We build the worker thread (the strong smoothness win) but omit the strict sim-time apply-landmark + backpressure-stall machinery. Determinism is preserved where it matters (the sim stream + an `inline` optimizer mode for tests); live plan-apply timing is intentionally best-effort.

---

## 3. Goals / Non-goals

**Goals**
1. Decouple wall-clock tick cadence from sim speed via a fixed-cadence accumulator.
2. Remove the optimizer's CPU cost from the playback loop (worker thread).
3. Preserve byte-identical simulation determinism and keep all existing golden/integration tests green.
4. Demo runs smoothly at 64× with `fleetPerSpoke=3` (~30 trucks): frames keep delivering, `simClock` keeps advancing, no freeze.

**Non-goals**
- No change to the simulation domain model or event schema (that's sub-project 2: rest/fuel stops).
- No strict end-to-end replay of plan-apply timing.
- No client-side rendering rework.
- No new infra (no Redis/BullMQ/Kafka). Worker = Node `worker_threads`, in-process.

---

## 4. Component A — Accumulator pacer

**File:** `packages/api/src/sim/driver.ts` (rework `driveSimulationPaced`), with the speed math centralized in `packages/api/src/sim/speed-controller.ts`.

### Behavior
- **Fixed frame cadence** `FRAME_MS` (default **250 ms**), scheduled via chained `setTimeout` using a measured `performance.now()` delta (never `setInterval`). Env: `SIM_FRAME_MS`.
- Each frame:
  1. `wallDeltaMs = now - lastWall` (clamped to a sane max, e.g. 1000 ms, to avoid huge jumps after a stall/GC pause).
  2. `simAdvanceMs = wallDeltaMs × (MS_PER_TICK / DEFAULT_INTERVAL_MS) × speedMultiplier` → `= wallDeltaMs × 120 × multiplier`. **Preserves today's semantics** (1× = 120× compression; 64× = 7680×).
  3. `simClock += simAdvanceMs`.
  4. **Drain**: pop every pre-baked tick whose `occurredAt ≤ simClock`. Append all their events as **one batch**, run projection **once**, emit **one** WS delta for the frame.
- **Max-work budget** `MAX_TICKS_PER_FRAME` (default e.g. **32**, env `SIM_MAX_TICKS_PER_FRAME`): if a frame would drain more than the budget, drain only the budget, clamp `simClock` to the last drained tick's `occurredAt`, and carry the remainder to the next frame. Bounds DB work/frame and yields to the event loop. When the loop is budget-saturated, the *effective* max speed self-limits gracefully instead of freezing.
- **Pause**: `speedMultiplier === 0` ⇒ `simAdvanceMs = 0`, `simClock` frozen. Same observable behavior as today.
- **End of stream**: when all pre-baked ticks are drained, stop the frame loop (unchanged termination semantics).

### Speed controller changes
- Keep the public multiplier range [0.25, 64] and the `/api/sim/speed` contract **unchanged** (client compatibility).
- `getTickIntervalMs()` is no longer the pacing primitive. The controller now exposes `getMultiplier()` (and keeps reporting `speed` in WS envelopes). The interval→multiplier mapping that the client reads stays reportable for backward compatibility, but the *driver* consumes `multiplier` directly.

### WS broadcast
- Still **one delta per frame** via `diffTick(prev, current)`. `simMs` in the envelope = `simClock` (authoritative). Frequency is now constant (~4/s at `FRAME_MS=250`) regardless of speed; the *size* of each delta grows with speed (more ticks drained), which is the correct trade.

---

## 5. Component B — Worker-thread optimizer

**Files:** `packages/api/src/optimizer/` — new `optimizer-worker.ts` (worker entry) + a `WorkerOptimizerClient` wrapper; `live-loop.ts` adapted to call through the client.

### Boundary (SOLID: pure compute in worker, I/O on main)
- **Worker = pure CPU**: receives a serialized snapshot (`OptimizerSnapshot`) + sim-time, builds the time-expanded graph, runs min-cost-flow SSP + VRPTW, returns a `Plan` (and any derived epoch payload). **No DB, no `Date.now()`** inside the worker.
- **Main thread = I/O + orchestration**: builds the snapshot from projections, posts it to the worker, and on result **appends** the epoch/plan events with optimistic concurrency. **Single writer preserved** (avoids the concurrent-writer hazard noted in the M-1/M-2 readAll cursor caveat).

### Lifecycle & scheduling
- **Long-lived worker**: spawn **once** at startup, reuse for every job (no per-job spawn cost). Clean shutdown on server close.
- **Trigger** (deterministic, unchanged in spirit): the existing every-N-ticks/sim-minutes landmark. On the frame that crosses a landmark, main thread builds + posts the snapshot. **Never awaited inside the frame.**
- **Single-flight + dirty-flag coalescing**: at most one job in flight. If another landmark is crossed while busy, set `dirty` (store latest snapshot). When the job returns, if `dirty`, immediately re-post the latest. Prevents unbounded queue growth at 64×.
- **On result**: main thread appends plan/epoch events; they flow into the next frame's WS delta (best-effort apply).

### Execution-mode flag (determinism for tests)
- Config `optimizer.execution: 'worker' | 'inline'` (env `OPTIMIZER_EXECUTION`, default `worker` in the demo server, `inline` in tests).
  - `inline`: synchronous, in-process, awaited — **byte-for-byte the current behavior**. All existing optimizer-rolling / HOS-live integration tests run in this mode → unchanged.
  - `worker`: async, off-path, coalesced (demo).
- The optimizer compute function is the **same code** in both modes (shared module imported by the worker entry and by the inline path) — no logic divergence, only the transport differs (DIP).

---

## 6. Data flow (worker mode)

```
every FRAME_MS:
  frame():
    simClock += wallDelta × 120 × multiplier            (clamped)
    batch = drain ticks where occurredAt ≤ simClock      (≤ MAX_TICKS_PER_FRAME)
    append(batch.events); project once                   (main thread, single writer)
    if crossed optimizer landmark:
       if !busy: post(snapshot) → worker; busy = true
       else: dirty = true; latestSnapshot = snapshot
    broadcast(diffTick(prev, current), simMs = simClock)

worker.onResult(plan):                                   (async, later)
    append(plan.epochEvents)                              (main thread)
    busy = false
    if dirty: dirty = false; post(latestSnapshot) → worker; busy = true
    // plan surfaces in the next frame's delta
```

---

## 7. Determinism strategy

| Concern | Guarantee |
|---------|-----------|
| Simulation event stream | Unchanged — still produced by seeded `simulate()`; `determinism.unit.test.ts` (and HOS/fleet variants) pass as-is. |
| Optimizer in tests | `inline` mode → synchronous, sim-time-keyed (epoch from `simMs`, never `Date.now()`), identical to today. |
| Optimizer in demo | `worker` mode → *contents* deterministic for a given snapshot+sim-time; *apply moment* best-effort. No wall-clock-based throttling (trigger is sim-time landmark). |
| Pacer | `simClock` advance is a pure function of accumulated `wallDelta × speed`; the *set of events drained by a given simClock* is deterministic. Real-time pacing of frames is intentionally wall-clock (presentation only). |

---

## 8. Config knobs (new + changed)

| Knob | Env | Default | Notes |
|------|-----|---------|-------|
| Frame cadence | `SIM_FRAME_MS` | 250 | Fixed wall-clock frame. |
| Max ticks/frame | `SIM_MAX_TICKS_PER_FRAME` | 32 | Backpressure budget; carries remainder. |
| Optimizer execution | `OPTIMIZER_EXECUTION` | `worker` (demo) / `inline` (tests) | Transport selector. |
| Optimizer cadence | `OPTIMIZER_EVERY_TICKS` | 8 (existing) | Deterministic sim-time landmark; unchanged. |
| Speed multiplier range | (existing) | [0.25, 64] | API contract unchanged. |
| `SIM_TICK_INTERVAL_MS` | (existing) | 500 | Retained only as the 1× compression baseline constant (`DEFAULT_INTERVAL_MS`) in the advance math; no longer the pacing primitive. |

---

## 9. Testing strategy (TDD)

**Unit (new):**
- Accumulator advance math: `simAdvanceMs` vs multiplier (1× → 120× rate; 64× → 7680× rate); pause (0×) freezes `simClock`; `wallDelta` clamp.
- Drain batching: all ticks with `occurredAt ≤ simClock` drained; ordering preserved; one delta/frame.
- Max-work budget: over-budget frame drains exactly the budget, clamps `simClock`, carries remainder; sequence continuity across frames.
- Single-flight/dirty coalescing: concurrent landmarks ⇒ ≤1 job in flight; dirty re-post once; no queue growth.
- Worker client round-trip with a **mocked worker** (no real thread in unit tests): post→result→append path; `inline` vs `worker` produce the same plan for the same snapshot.

**Integration (existing, must stay green in `inline`):**
- `optimizer-rolling.int.test.ts`, `optimizer-hos-live.int.test.ts`, `live-demo.int.test.ts`.

**Soak / perf (new — proves the actual bug is fixed):**
- 64× + `fleetPerSpoke=3` (~30 trucks): over a fixed wall-clock window, assert frames keep delivering (delta count ≥ threshold) and `simClock` advances monotonically past a target — i.e. **no freeze**. Run with the real worker.

---

## 10. Acceptance criteria

1. `pnpm build` (turbo) + full test suite green; no `any`, strict TS, lint clean.
2. All pre-existing sim/optimizer determinism + integration tests pass unmodified (in `inline` mode).
3. New unit tests for accumulator, budget, coalescing, worker round-trip pass.
4. Soak test demonstrates no freeze at 64× / 30 trucks (frames + simClock keep advancing).
5. `/api/sim/speed` contract unchanged; client needs no changes to keep working.
6. Manual demo check (browser, chrome-devtools/playwright): live map animates smoothly across 1×→64× with ~30 trucks; speed changes take effect; pause/resume works.

---

## 11. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Worker snapshot serialization cost (structured clone of a large network state) | Measure during build; reuse one worker; keep snapshot minimal (only optimizer inputs). Defer SharedArrayBuffer (YAGNI). |
| Worker can't reach DB | By design it doesn't — main thread owns all DB I/O; worker is pure compute. |
| Best-effort plan lag at extreme speed | Acceptable per decision; coalescing keeps it to the latest snapshot; demo remains visually coherent (old plan stays in effect until replaced). |
| Large per-frame delta at 64× saturates WS | Max-ticks budget bounds per-frame work; effective speed self-limits gracefully. |
| Behavior drift between `inline` and `worker` | Shared compute module imported by both; round-trip test asserts identical plan for identical input. |

---

## 12. File-level change map (anticipated)

- `packages/api/src/sim/driver.ts` — accumulator frame loop replaces interval-shrink loop.
- `packages/api/src/sim/speed-controller.ts` — expose multiplier as pacing primitive; keep reporting + API contract.
- `packages/api/src/optimizer/optimizer-worker.ts` *(new)* — worker entry (pure compute).
- `packages/api/src/optimizer/worker-client.ts` *(new)* — long-lived worker client (post/result/coalesce/shutdown).
- `packages/api/src/optimizer/live-loop.ts` — call through client; `inline`|`worker` selector.
- `packages/api/src/main.ts` — wire `SIM_FRAME_MS`, `SIM_MAX_TICKS_PER_FRAME`, `OPTIMIZER_EXECUTION`; spawn/own worker lifecycle.
- Tests as in §9.

---

## 13. Out of scope → sub-project 2 (separate spec)

Meaningful **rest/fuel stops** (rest areas: sleeping per HOS 10-h, 30-min break, meal/restroom; fuel refueling ~every 1,000–1,500 mi). Changes the deterministic sim domain (new events, golden-test impact) and is brainstormed separately. Research already gathered (Class 8: 240–300 gal tanks, ~7 mpg, ~1,300–1,750 mi operational range, daily top-off aligned with rest; HOS durations already modeled in v1.2).
