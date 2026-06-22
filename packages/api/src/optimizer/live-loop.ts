import type { DomainEvent } from "@mm/domain";
import type { EpochResult, TwinSnapshot } from "@mm/optimizer";
import type { RollingOptimizerService } from "./rolling-service.js";

/**
 * `@mm/api` — `RollingLoop`: the live periodic + event-triggered rolling
 * optimizer driver (Plan 05-02, OPT-02/05/06).
 *
 * This is the THIN composition shell that:
 *  1. Calls the injected `buildSnapshot` port to read the current live twin.
 *  2. Constructs the `Epoch` with `nowMin` derived from `simMs` (the sim/event
 *     clock — NEVER `Date.now()`).
 *  3. Delegates to `RollingOptimizerService.runOnce` (the Phase-4 shell that
 *     owns the pure `runEpoch` call + the ONE OCC-safe plan append).
 *  4. Returns the `EpochResult` for callers (ws broadcast, KPI endpoint, etc.).
 *
 * The loop honors the full Phase-4 contract:
 *  - OPT-05 scope: `runEpoch` internally calls `detectAffectedScope(events)`.
 *    An empty-events tick ⇒ empty scope ⇒ empty result (no append, bounded work).
 *  - OPT-06 idempotency: `RollingOptimizerService` memoizes per `(epochId, scopeHash)`.
 *    Two ticks with the same `(simMs, events)` produce ONE plan append at most.
 *  - OPT-02 min-cost-flow: `runEpoch` runs TWO orthogonal stages on the live
 *    twin (assign-then-sequence). FIRST, the freight stage
 *    (`assignFreightForEpoch` → `buildTimeExpandedGraph` + `assignFreight` /
 *    `minCostFlow`) answers "which freight block flows over which route leg at
 *    minimum total cost" — its result is surfaced on `EpochResult.freightAssignment`.
 *    SECOND, `routeTrailers` (VRPTW) *sequences* each trailer's stops + the
 *    objective scores the candidate. MCF is observational (it does NOT change the
 *    deterministic selectPlan winner). This loop is the live trigger that drives
 *    that full chain end-to-end on the live twin.
 *  - T-04-14 OCC: `RollingOptimizerService.appendPlan` uses `appendWithRetry`
 *    (reload + retry on `ConcurrencyError`). Two concurrent ticks for the same
 *    stream converge — neither loses a write, no duplicate accept.
 *
 * Design (DIP / KISS):
 *  - `buildSnapshot` is a port: tests inject a `vi.fn().mockResolvedValue(...)`;
 *    production passes the `buildTwinSnapshot(db)` closure.
 *  - `epochId` is derived deterministically from `nowMin` so replaying the same
 *    tick sequence yields the same epoch ids (anti-P7, idempotency key stable).
 */

/** Port: builds the planning twin from the live projections. */
export type BuildSnapshot = (db?: unknown) => Promise<TwinSnapshot>;

/** Construction config for {@link RollingLoop}. */
export interface RollingLoopConfig {
  /** The stateful shell that owns the pure epoch + the ONE plan append. */
  readonly service: RollingOptimizerService;
  /**
   * The snapshot builder port. The loop calls it before every tick to read the
   * current live projections. Tests inject a stub; production passes
   * `() => buildTwinSnapshot(db)`.
   */
  readonly buildSnapshot: () => Promise<TwinSnapshot>;
  /**
   * Near-departure freeze window in minutes (OPT-06). A trailer departing within
   * `[now, now+freeze]` is skipped this epoch — its plan is left untouched.
   */
  readonly freezeWindowMin: number;
}

/** What the caller passes per tick (the sim/event time + triggering events). */
export interface TickInput {
  /**
   * The batch of new domain events since the last tick. These drive scope
   * detection (OPT-05): only the affected trailers/hubs are re-optimized.
   * Pass `[]` for a periodic (non-event-triggered) tick.
   */
  readonly events: readonly DomainEvent[];
  /**
   * The simulation / event-log timestamp for this tick, in wall-clock
   * milliseconds from the Unix epoch. `nowMin` is derived as
   * `Math.floor(simMs / 60_000)` — NEVER from `Date.now()`.
   */
  readonly simMs: number;
}

/**
 * Derive a deterministic, stable epoch id from `nowMin`. Using a fixed-format
 * string keeps the id human-readable in logs and makes the idempotency key
 * stable across replays of the same sim tick (anti-P7).
 */
function epochIdFor(nowMin: number): string {
  return `epoch-${nowMin}`;
}

/**
 * The live rolling-optimizer driver. One instance per composition root; the
 * sim driver (or the ws tick handler) calls `loop.tick(...)` after each tick's
 * events have been appended + projections folded.
 */
export class RollingLoop {
  private readonly service: RollingOptimizerService;
  private readonly buildSnapshot: () => Promise<TwinSnapshot>;
  private readonly freezeWindowMin: number;

  constructor(config: RollingLoopConfig) {
    this.service = config.service;
    this.buildSnapshot = config.buildSnapshot;
    this.freezeWindowMin = config.freezeWindowMin;
  }

  /**
   * Run one rolling epoch for the given tick. Steps:
   *  1. Build the live twin snapshot (read-only projection read).
   *  2. Construct the `Epoch` with `nowMin` from `simMs` (NEVER `Date.now`).
   *  3. Delegate to `service.runOnce(epoch, input)`.
   *  4. Return the `EpochResult` (recommendations + generated/accepted).
   */
  async tick(input: TickInput): Promise<EpochResult> {
    const twinSnapshot = await this.buildSnapshot();
    const nowMin = Math.floor(input.simMs / 60_000);
    const epoch = {
      epochId: epochIdFor(nowMin),
      nowMin,
      freezeWindowMin: this.freezeWindowMin,
    };
    const epochInput = { events: input.events, twinSnapshot };
    const { result } = await this.service.runOnce(epoch, epochInput);
    return result;
  }
}
