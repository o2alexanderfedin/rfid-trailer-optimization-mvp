# Paced-Loop Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **This plan is executed by competing rival agents in isolated worktrees; a judge selects the best.** Implement the WHOLE plan; compete on correctness, test quality, and SOLID/KISS/DRY adherence — not on resolving ambiguity differently. Where this plan fixes a contract (interfaces, test-contract policy), follow it exactly so rival outputs stay comparable and mergeable.

**Goal:** Decouple the live demo's wall-clock tick cadence from sim speed (fixed-cadence accumulator) and move the optimizer's CPU compute into a long-lived worker thread, so the demo stays smooth at 64× with ~30 trucks — with no loss of simulation determinism.

**Architecture:** `driveSimulationPaced` becomes a fixed-frame accumulator: each frame advances a `simClock` by `wallDelta × ratePerMs × multiplier`, drains all pre-baked ticks with `occurredAt ≤ simClock` as one batch (bounded by a max-ticks budget), and emits ONE WS delta per frame. The optimizer is triggered non-blocking via a single-flight/dirty coalescer; its pure `runEpoch` compute runs in a `worker_threads` worker (main thread keeps all DB I/O = single writer). A `RunEpochFn` port (default inline) preserves byte-for-byte behavior for every existing test.

**Tech Stack:** TypeScript 5.9 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Node 22 `worker_threads` (no new dependency), Vitest 4, Fastify 5, Kysely/pg, pnpm workspaces + Turborepo. Packages: `@mm/api` (all changes here), reusing pure `runEpoch` from `@mm/optimizer`.

## Global Constraints

- No `any`; no type assertions to silence errors; no non-null assertions added beyond existing style. Use discriminated unions / explicit types. (CLAUDE.md strict-typing mandate.)
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit. Frequent atomic commits.
- The **simulation event stream must remain byte-identical** (same seed → same stream). Pacing/pause/speed/worker NEVER feed `simulate`, the event store, or the optimizer epoch clock. Determinism is asserted by `@mm/simulation` goldens + `driver.test.ts` determinism cases — these MUST stay green unmodified.
- `driveSimulation` (synchronous, non-paced) MUST NOT change behavior — all `packages/api/test/*.int.test.ts` pass unmodified.
- Default `OPTIMIZER_EXECUTION=inline` everywhere except the runnable demo (`main.ts`), so every existing optimizer/loop/integration test runs the inline path unchanged.
- Gate before "done": `pnpm build` (turbo, NOT just `pnpm -r build` — a turbo build catches workspace cycles the recursive build tolerates), full `pnpm test`/`test:all`, and `pnpm lint` — all clean.
- Follow existing patterns: DIP via injected ports (see `makeSimRunner`, `BuildSnapshot`), pure-core + thin-shell (see `RollingOptimizerService`), one-writer event store, presentation-pacing-is-not-determinism comments.

---

## File Structure

- `packages/api/src/sim/speed-controller.ts` *(modify)* — add `getMultiplier()`; keep the `/sim/speed` contract and all existing methods.
- `packages/api/src/sim/pacing.ts` *(create)* — pure accumulator helpers: `computeSimAdvanceMs`, `selectDrain`. One responsibility: the math of "how far does sim-time move and which ticks drain," no I/O.
- `packages/api/src/sim/pacing.test.ts` *(create)* — unit tests for `pacing.ts`.
- `packages/api/src/sim/coalesced-runner.ts` *(create)* — `makeCoalescedRunner`: single-flight + dirty-flag wrapper over a `SimTickRunner`. One responsibility: non-blocking optimizer scheduling.
- `packages/api/src/sim/coalesced-runner.test.ts` *(create)* — unit tests.
- `packages/api/src/sim/driver.ts` *(modify)* — rework `driveSimulationPaced` to the accumulator + coalescer + per-frame broadcast + budget. `driveSimulation`, `driveSimulationWithScenario`, `makeSimRunner`, `intoTicks`, `driveTickStream` UNCHANGED.
- `packages/api/src/sim/driver.test.ts` *(modify)* — rewrite ONLY the `driveSimulationPaced — loop body` describe block to the accumulator contract (see Task 4 test policy). Leave determinism, `makeSimRunner`, HOS-wiring describes intact (adjust HOS collection only if needed, see Task 4).
- `packages/api/src/optimizer/rolling-service.ts` *(modify)* — add optional `runEpochFn` dep (default inline `runEpoch`); `runOnce` awaits it.
- `packages/api/src/optimizer/rolling-service.test.ts` *(modify/extend if present, else add cases)* — assert inline default == `runEpoch`, injected fn is used.
- `packages/api/src/optimizer/optimizer-worker.ts` *(create)* — `worker_threads` entry: receives `{id, epoch, input, weights}`, replies `{id, ok, result}` or `{id, ok:false, error}`; runs pure `runEpoch`.
- `packages/api/src/optimizer/worker-client.ts` *(create)* — `makeWorkerOptimizer()`: spawns ONE worker, exposes `run(epoch, input, weights): Promise<EpochResult>` (request/response by id) and `close(): Promise<void>`. Implements a `RunEpochFn`.
- `packages/api/src/optimizer/worker-client.test.ts` *(create)* — real-worker round-trip + parity with inline `runEpoch` + shutdown.
- `packages/api/src/server.ts` *(modify)* — wire `OPTIMIZER_EXECUTION`; build worker client when `worker`; pass `runEpochFn` to the service; expose worker for shutdown; thread pacing knobs.
- `packages/api/src/main.ts` *(modify)* — read `SIM_FRAME_MS`, `SIM_MAX_TICKS_PER_FRAME`, `OPTIMIZER_EXECUTION`; pass to driver/server; close worker on shutdown.
- `packages/api/test/paced-soak.int.test.ts` *(create)* — no-freeze soak at 64× / fleetPerSpoke=3.

---

## Interfaces (the fixed contract — all tasks depend on these)

```ts
// speed-controller.ts (added to SpeedController)
getMultiplier(): number; // = defaultIntervalMs / tickIntervalMs (1 at default, [0.25,64])

// pacing.ts
/** Sim-ms to advance this frame. Pure. multiplier 0 (paused) ⇒ 0. wallDeltaMs clamped by caller or here. */
export function computeSimAdvanceMs(args: {
  readonly wallDeltaMs: number;     // measured elapsed since last frame (>=0)
  readonly multiplier: number;      // speed multiplier (0 = paused)
  readonly msPerTick: number;       // sim-ms per tick (60_000)
  readonly defaultIntervalMs: number; // 1x baseline wall interval (500)
  readonly maxWallDeltaMs?: number; // clamp huge gaps (default 1000)
}): number; // = clampedWallDelta * (msPerTick / defaultIntervalMs) * multiplier

/** Which pre-baked ticks drain this frame, honoring the budget. Pure. */
export function selectDrain(args: {
  readonly tickTimesMs: readonly number[]; // occurredAt(ms) of ticks[i] (first event of each tick)
  readonly nextIndex: number;              // first undrained tick index
  readonly simClock: number;               // current sim-clock (ms)
  readonly maxTicks: number;               // budget per frame (>=1)
}): {
  readonly count: number;        // ticks to drain this frame [0, maxTicks]
  readonly clampSimClock: number; // simClock clamped to last drained tick time when budget-capped, else input simClock
};

// coalesced-runner.ts
export interface CoalescedRunner {
  /** Non-blocking: fire the optimizer for these events at simMs, or coalesce if busy. */
  trigger(events: readonly DomainEvent[], simMs: number): void;
  /** Resolves when no job is in flight and nothing is pending (drain to idle). */
  whenIdle(): Promise<void>;
}
export function makeCoalescedRunner(runner: SimTickRunner): CoalescedRunner;

// rolling-service.ts (added to RollingOptimizerDeps)
export type RunEpochFn = (
  epoch: Epoch, input: EpochInput, weights: ObjectiveWeights,
) => Promise<EpochResult>;
// RollingOptimizerDeps gains: readonly runEpochFn?: RunEpochFn; (default: (e,i,w)=>Promise.resolve(runEpoch(e,i,w)))

// worker-client.ts
export interface WorkerOptimizer {
  run: RunEpochFn;           // posts to the worker, resolves with EpochResult
  close(): Promise<void>;    // terminate the worker
}
export function makeWorkerOptimizer(): WorkerOptimizer;

// driver.ts — DriveSimulationPacedOptions gains (all optional, back-compat):
//   readonly frameMs?: number;            // fixed wall-clock frame, default 250
//   readonly maxTicksPerFrame?: number;   // drain budget, default 32
//   readonly getMultiplier?: () => number;// live speed source (preferred over getTickIntervalMs)
// `optimizerEveryTicks` retained = sim-time landmark cadence (every N drained ticks ⇒ one optimizer trigger).
// `getTickIntervalMs`/`tickIntervalMs`/`resolveTickIntervalMs` may be removed (see Task 4).
```

**Speed math identity (must hold):** `ratePerMs = msPerTick / defaultIntervalMs = 60000/500 = 120`. So at multiplier `m`, sim advances `wallDeltaMs × 120 × m`. At `frameMs=250, m=64`: `250×120×64 = 1,920,000 ms = 32 ticks` ⇒ `maxTicksPerFrame=32` is exactly 64× at a 250 ms frame; beyond that the budget self-limits effective speed instead of freezing.

---

### Task 1: Speed controller — expose multiplier as the pacing primitive

**Files:** Modify `packages/api/src/sim/speed-controller.ts`; Test `packages/api/src/sim/speed-controller.test.ts`.

**Interfaces:** Produces `SpeedController.getMultiplier(): number`. Consumed by Task 4 (driver) and Task 7 (wiring).

- [ ] **Step 1 — failing test:** add cases asserting `getMultiplier()` returns `1` at default, `64` after `apply({multiplier:64})`, `0.25` after `apply({multiplier:0.25})`, and that it equals `snapshot().multiplier`. Also assert pause does NOT change `getMultiplier()` (pause is separate; multiplier is the rate, `isPaused()`/`getSimSpeed()` carry the freeze).
- [ ] **Step 2 — run, verify fail** (`getMultiplier` undefined). `pnpm --filter @mm/api test speed-controller`.
- [ ] **Step 3 — implement:** add `getMultiplier: () => defaultIntervalMs / tickIntervalMs` to the returned object. Keep all existing methods/semantics and the `/sim/speed` contract.
- [ ] **Step 4 — run, verify pass.** Also run the existing `sim-speed.test.ts` route test — must stay green.
- [ ] **Step 5 — commit:** `feat(api): SpeedController.getMultiplier (pacing primitive)`.

---

### Task 2: Pure accumulator helpers (`pacing.ts`)

**Files:** Create `packages/api/src/sim/pacing.ts` + `pacing.test.ts`.

**Interfaces:** Produces `computeSimAdvanceMs`, `selectDrain` (signatures above). Consumed by Task 4.

- [ ] **Step 1 — failing tests** (`pacing.test.ts`), covering:
  - `computeSimAdvanceMs`: `{wallDeltaMs:250, multiplier:1, msPerTick:60000, defaultIntervalMs:500}` → `30000`; `multiplier:64` → `1920000`; `multiplier:0` → `0`; `wallDeltaMs:100000` clamps to `maxWallDeltaMs` default 1000 → `1000×120×m`.
  - `selectDrain`: given `tickTimesMs=[0,60000,120000,180000]`, `nextIndex:0`, `simClock:130000`, `maxTicks:32` → `{count:3, clampSimClock:130000}` (ticks at 0,60k,120k ≤ 130k). With `maxTicks:2` → `{count:2, clampSimClock:60000}` (capped; clamp to last drained tick time = index1=60000). With `simClock:-1` → `{count:0, clampSimClock:-1}`. With `nextIndex` past end → `{count:0,...}`.
- [ ] **Step 2 — run, verify fail.**
- [ ] **Step 3 — implement** both as pure functions; no I/O, no `Date.now()`.
- [ ] **Step 4 — run, verify pass.**
- [ ] **Step 5 — commit:** `feat(api): pure accumulator pacing helpers`.

---

### Task 3: Coalesced optimizer runner (`coalesced-runner.ts`)

**Files:** Create `packages/api/src/sim/coalesced-runner.ts` + `coalesced-runner.test.ts`.

**Interfaces:** Produces `makeCoalescedRunner(runner): CoalescedRunner`. Consumed by Task 4.

**Semantics (lock exactly):** single in-flight job. `trigger(events, simMs)`: if idle → start job with these events at this simMs, mark busy. If busy → append `events` to a pending buffer and remember the LATEST `simMs`; mark dirty. On job settle (resolve OR reject — never wedge): if dirty → start a new job with the accumulated pending events + latest simMs, clear pending/dirty; else mark idle. `whenIdle()` resolves once idle with nothing pending. No events are dropped (union of all `trigger` events == union of all events passed to `runner`).

- [ ] **Step 1 — failing tests:**
  - Concurrent triggers while a (manually-controlled, deferred) runner is in flight ⇒ runner invoked at most once until it settles; second invocation carries the union of pending events and the latest simMs.
  - `whenIdle()` resolves only after the last coalesced job settles.
  - Union-preservation: across N triggers with disjoint events, the concatenation of `runner` call args equals the union (no drop, no dup).
  - A rejecting runner still releases busy and processes pending (no wedge); `whenIdle()` resolves.
- [ ] **Step 2 — run, verify fail.**
- [ ] **Step 3 — implement** the state machine (KISS: booleans `busy`/`dirty`, `pendingEvents: DomainEvent[]`, `pendingSimMs`). Use `SimTickRunner` (`(events, simMs)=>Promise<EpochResult|undefined>`).
- [ ] **Step 4 — run, verify pass.**
- [ ] **Step 5 — commit:** `feat(api): single-flight/dirty coalesced optimizer runner`.

---

### Task 4: Rework `driveSimulationPaced` to the accumulator model

**Files:** Modify `packages/api/src/sim/driver.ts`; rewrite the paced-loop describe in `driver.test.ts`.

**Interfaces:** Consumes Task 1 (`getMultiplier`), Task 2 (`pacing`), Task 3 (`coalesced-runner`). Produces the reworked `driveSimulationPaced` + extended `DriveSimulationPacedOptions`.

**Behavior to implement:**
1. Generate stream + `intoTicks` (unchanged). Precompute `tickTimesMs[i] = new Date(ticks[i][0].occurredAt).getTime()`.
2. Build the coalescer over `makeSimRunner({loop})`.
3. Frame loop via chained `setTimeout(frameMs)` (default 250; NOT `setInterval`), measuring `wallDeltaMs` with `performance.now()`. On each frame:
   - read `multiplier` (prefer `getMultiplier?.()`, else 1) and pause (`isPaused?.()` true ⇒ treat multiplier as 0 so `simClock` is frozen).
   - `simClock += computeSimAdvanceMs({wallDeltaMs, multiplier, msPerTick:60000, defaultIntervalMs:500})`.
   - `selectDrain({tickTimesMs, nextIndex, simClock, maxTicks:maxTicksPerFrame})`; set `simClock = clampSimClock`.
   - For each drained tick (in order) run the EXISTING per-tick body (a)–(e): append OCC per stream, departed-hub tracking, inline projection, detection, catchup — preserving cross-tick `cursor`/`departedHubs`. (Refactor the shared per-tick body into a local closure to avoid duplication / DRY; do NOT change its semantics.)
   - Optimizer landmark: accumulate drained ticks' events; every `optimizerEveryTicks` drained ticks (and once more after the last tick drains) call `coalescer.trigger(batchedEvents, lastDrainedTickMs)` — NON-blocking.
   - Broadcast ONCE per frame if anything drained (or always, to keep `simMs`/speed envelopes flowing for the client clock — choose "broadcast every frame" so pause/speed reflect; pass `simClock` as `simMs`). Document the choice.
4. Termination: when all ticks drained, stop the frame loop, `await coalescer.whenIdle()`, do a final broadcast at `simClock`, resolve `{ ticks: drainedCount }`.
5. Remove `getTickIntervalMs`/`tickIntervalMs`/`resolveTickIntervalMs` from the paced path (delete `resolveTickIntervalMs` + its tests if no longer used elsewhere — confirm via grep; it is only used by the paced driver + its test). Keep `PAUSE_POLL_MS`/`sleep` only if still needed.

**Test-contract policy (rewrite the `driveSimulationPaced — loop body` describe):** the OLD assertions tied to per-tick pacing are replaced. New hermetic cases (keep the existing heavy-module mocks + `buildFakeDb`/`recordingBroadcast`/`recordingLoop`):
- **All events delivered:** the union of `loopCalls` events (across coalesced calls) contains the same event multiset as the source stream's events (drive with a tiny `frameMs`, large `maxTicksPerFrame`). Non-vacuous: stream has events.
- **simClock monotonic & complete:** `result.ticks` equals the source tick count; the last broadcast `simMs` ≥ the last tick's time.
- **One broadcast per frame, not per tick:** with `maxTicksPerFrame` ≥ tick count and a single frame draining all, assert `broadcasts.length` < `result.ticks` (batched) OR ≥1 — assert the batching property precisely (e.g., draining all ticks in one frame ⇒ `broadcasts.length` ≤ frames driven, and every tick still reached the optimizer).
- **Budget carry:** with `maxTicksPerFrame:1` and enough sim-advance for many ticks, assert ticks drain across multiple frames (carry works) and all still deliver.
- **Pause freezes:** `isPaused` true for several frames ⇒ `simClock`/drain do not advance during the hold; after release, the run completes and all events deliver.
- **Determinism preserved:** two runs with different `frameMs`/pause schedules yield the SAME union event multiset into the optimizer (pacing never reaches `simulate`). (The exact per-call batching may differ; assert the multiset/union equality, not call-by-call equality.)
- Keep the `makeSimRunner`, `sim stream determinism`, and HOS-wiring describes. For HOS-wiring, it collects `calls.flatMap(c => c.events)`; that still holds (coalescer preserves the union). If a timing/batching nuance makes a strict equality flaky, assert via `Set`/multiset of event types as those tests already do.

- [ ] **Step 1 — write the new paced-loop tests** (RED) per the policy above.
- [ ] **Step 2 — run, verify fail.**
- [ ] **Step 3 — implement** the accumulator rework (extract shared per-tick body; wire pacing + coalescer).
- [ ] **Step 4 — run** `pnpm --filter @mm/api test driver` until green; ensure determinism + HOS + makeSimRunner describes still pass.
- [ ] **Step 5 — commit:** `feat(api): accumulator paced driver (fixed cadence + per-frame batch + coalesced optimizer)`.

---

### Task 5: `RunEpochFn` port on `RollingOptimizerService`

**Files:** Modify `packages/api/src/optimizer/rolling-service.ts` (+ its test).

**Interfaces:** Adds `runEpochFn?: RunEpochFn` to `RollingOptimizerDeps`; `runOnce` calls `await this.runEpochFn(epoch, input, weights)`. Default = `(e,i,w)=>Promise.resolve(runEpoch(e,i,w))`. Consumed by Task 7.

- [ ] **Step 1 — failing test:** (a) with NO `runEpochFn`, `runOnce` produces the SAME `EpochResult` as calling `runEpoch` directly for a given epoch+input (inline default unchanged); (b) an injected `runEpochFn` spy IS invoked and its returned result drives memo/append (use a spy returning a known result with `accepted:null` ⇒ no append, and one with an accept ⇒ exactly one append).
- [ ] **Step 2 — run, verify fail.**
- [ ] **Step 3 — implement:** store `this.runEpochFn = deps.runEpochFn ?? ((e,i,w)=>Promise.resolve(runEpoch(e,i,w)))`; change the synchronous `runEpoch(...)` call in `runOnce` to `await this.runEpochFn(...)`. Everything else (memo key, `appendPlan`, `latest`/`latestNonEmpty`) unchanged.
- [ ] **Step 4 — run** the FULL optimizer + loop + integration suites in inline mode — all must pass unmodified.
- [ ] **Step 5 — commit:** `feat(api): RunEpochFn port on RollingOptimizerService (inline default)`.

---

### Task 6: Worker thread — entry + long-lived client

**Files:** Create `packages/api/src/optimizer/optimizer-worker.ts`, `worker-client.ts`, `worker-client.test.ts`.

**Interfaces:** Produces `makeWorkerOptimizer(): WorkerOptimizer` whose `.run` is a `RunEpochFn`. Consumed by Task 7.

**Worker entry contract:** uses `node:worker_threads` `parentPort`. On message `{id:number, epoch, input, weights}` → compute `runEpoch(epoch, input, weights)` and `parentPort.postMessage({id, ok:true, result})`; on throw → `postMessage({id, ok:false, error: String(err)})`. The entry imports `runEpoch` + `DEFAULT_OBJECTIVE_WEIGHTS` from `@mm/optimizer`. Must be resolvable at runtime from compiled output (use `new URL(import.meta.url)` resolution or a `.js` path that exists post-build; verify the worker file is included in the build — see Step 3 note).

**Client contract:** spawn ONE `Worker` at construction; maintain a `Map<number, {resolve,reject}>` keyed by an incrementing id; `run(epoch,input,weights)` posts `{id,...}` and returns a Promise settled by the matching reply; `close()` terminates the worker and rejects any pending. Structured-clone handles `epoch/input/weights/EpochResult` (plain data). Guard against worker `error`/`exit` (reject all pending).

- [ ] **Step 1 — failing test** (`worker-client.test.ts`): build a real `TwinSnapshot`+`EpochInput`+`Epoch` (reuse an existing optimizer test fixture/helper, or the smallest snapshot the optimizer tests use), call `makeWorkerOptimizer().run(epoch,input,DEFAULT_OBJECTIVE_WEIGHTS)` and assert the result DEEP-EQUALS the inline `runEpoch(epoch,input,DEFAULT_OBJECTIVE_WEIGHTS)` (parity). Then `close()` and assert a subsequent `run` rejects (or the worker is gone). Mark the test appropriately if it needs a longer timeout for worker spawn.
- [ ] **Step 2 — run, verify fail** (modules missing).
- [ ] **Step 3 — implement** entry + client. **Build note:** ensure the worker module compiles to the package's `dist` and the client resolves it relative to its own compiled location (e.g., `new Worker(new URL("./optimizer-worker.js", import.meta.url))`). If the repo runs via `tsx`/ESM in tests, confirm the worker path resolves in both `vitest` and built modes; if needed, resolve a `.ts` entry under test and `.js` in prod via `import.meta.url` + existence, or run the worker through the same loader. Keep it simple; document the resolution choice in a comment.
- [ ] **Step 4 — run, verify pass** (real worker round-trip + parity + shutdown).
- [ ] **Step 5 — commit:** `feat(api): worker_threads optimizer (pure runEpoch offload) + client`.

---

### Task 7: Wire worker + pacing knobs into `buildServer` and `main.ts`

**Files:** Modify `packages/api/src/server.ts`, `packages/api/src/main.ts`. Extend `ServerDeps`/`BuiltServer` as needed.

**Interfaces:** `buildServer` constructs the optimizer service with `runEpochFn` from a worker when `OPTIMIZER_EXECUTION=worker` (default `inline`), exposes the worker on `BuiltServer` for shutdown. `main.ts` reads `SIM_FRAME_MS` (250), `SIM_MAX_TICKS_PER_FRAME` (32), `OPTIMIZER_EXECUTION` (default `worker` for the demo) and threads them.

- [ ] **Step 1 — failing test:** an `@mm/api` test (unit or int) asserting buildServer with `optimizerExecution:'inline'` (default) behaves as today, and that passing `optimizerExecution:'worker'` produces a `BuiltServer` carrying a closable worker. Keep it light (don't require Postgres if a unit-level seam suffices; otherwise an int test).
- [ ] **Step 2 — run, verify fail.**
- [ ] **Step 3 — implement:** add `optimizerExecution?: 'inline'|'worker'` to `ServerDeps` (default `'inline'`); when `'worker'`, `const worker = makeWorkerOptimizer()` and pass `runEpochFn: worker.run` to `new RollingOptimizerService({...})`; add `worker?: WorkerOptimizer` to `BuiltServer`; ensure `app` close / shutdown path calls `worker?.close()`. In `main.ts`: read env, pass `optimizerExecution: process.env.OPTIMIZER_EXECUTION === 'inline' ? 'inline' : 'worker'`, pass `frameMs`/`maxTicksPerFrame`/`getMultiplier: () => speedController.getMultiplier()` to `driveSimulationPaced`, and close the worker in `shutdown()`.
- [ ] **Step 4 — run** the `@mm/api` suite (inline default) — all green.
- [ ] **Step 5 — commit:** `feat(api): wire worker optimizer + pacing knobs (inline default, worker demo)`.

---

### Task 8: No-freeze soak integration test

**Files:** Create `packages/api/test/paced-soak.int.test.ts` (testcontainers Postgres, like the other `*.int.test.ts`).

- [ ] **Step 1 — failing test:** start a pg-backed `buildServer`, drive `driveSimulationPaced` with `fleetPerSpoke:3`, `frameMs:50`, `maxTicksPerFrame:32`, a `getMultiplier` returning 64, real `loop`, `optimizerExecution` BOTH ways if feasible (at least `inline`; `worker` if the worker resolves under vitest). Assert that within a bounded wall-clock window the run makes progress: broadcasts keep arriving (count grows over time) AND the final `simMs` reaches the end of the stream — i.e. no freeze. Use a generous wall-clock bound; the point is "advances," not a hard latency SLA.
- [ ] **Step 2 — run, verify fail** (until Task 4/7 land it can't pass; if Tasks done, it should pass — order accordingly).
- [ ] **Step 3 — implement** any test-only helpers needed; no production change expected.
- [ ] **Step 4 — run, verify pass.**
- [ ] **Step 5 — commit:** `test(api): paced-loop no-freeze soak (64x, fleet=3)`.

---

### Task 9: Full gate + demo verification

- [ ] **Step 1:** `pnpm build` (turbo) — zero errors.
- [ ] **Step 2:** `pnpm test` / `pnpm test:all` — all green (web jsdom + browser lanes too if part of the standard gate).
- [ ] **Step 3:** `pnpm lint` — zero warnings/errors. Fix ALL (including any pre-existing surfaced).
- [ ] **Step 4 — manual demo (browser):** start the API (`OPTIMIZER_EXECUTION=worker FLEET_PER_SPOKE=3`) + web; via chrome-devtools/playwright confirm the live map animates smoothly sweeping 1×→64×, speed changes take effect, pause/resume works, ~30 trucks move without freeze. Capture a screenshot.
- [ ] **Step 5 — commit** any lint/build fixups: `chore(api): paced-loop gate fixups`.

---

## Self-Review (against the spec)

- **Spec §4 accumulator** → Tasks 1,2,4. **§5 worker** → Tasks 5,6,7. **§6 data flow** → Task 4 (frame) + Task 5/6 (worker result append on main). **§7 determinism** → inline default (Task 5), pacing-never-reaches-simulate (Task 4 tests), sim goldens untouched (Global Constraints). **§8 config knobs** → Task 7. **§9 testing** → Tasks 2,3,4,6,8. **§10 acceptance** → Task 9. **§11 risks** → worker reuse (Task 6 long-lived), single-writer (Task 5/6 main-thread append), budget (Task 2/4), inline/worker parity (Task 6 parity test). No spec section is unmapped.
- **Placeholders:** none — every task has concrete files, signatures, and test assertions.
- **Type consistency:** `RunEpochFn` (Tasks 5,6,7) identical signature; `getMultiplier` (Tasks 1,4,7) identical; `computeSimAdvanceMs`/`selectDrain` (Tasks 2,4) identical; `makeCoalescedRunner` (Tasks 3,4) identical; `makeWorkerOptimizer`/`WorkerOptimizer` (Tasks 6,7) identical.
- **Known open implementation risk (flagged, not a blocker):** worker module path resolution under vitest vs built dist (Task 6 Step 3) — rivals must prove the round-trip test passes in the repo's actual test runner; if worker can't resolve under vitest, the worker parity test may run against the built output or be guarded, but the inline path must always pass.
```
