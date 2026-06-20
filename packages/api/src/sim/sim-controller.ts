/**
 * `SimController`: the mutable sim state manager (SIM-04).
 *
 * Holds the currently-active scenario knobs and drives scenario re-runs via
 * `driveSimulationWithScenario`. The scenario route (`POST /scenario`) calls
 * `injectScenario(knobs)` to set new knobs and immediately drive a scoped
 * re-run on the current DB state, which triggers the rolling optimizer
 * (via the injected `loop`) and broadcasts the re-opt on the ws tick stream.
 *
 * Design (DIP):
 *  - `SimController` is the `ScenarioController` port implementation.
 *  - The composition root wires it with the live `db`, `loop`, `broadcast`, and
 *    a short `reoptTicks` window (enough to trigger one optimizer epoch).
 *  - Tests inject mocks and never need a Postgres container.
 */

import type { ScenarioKnobs } from "@mm/simulation";
import type { ApiDb } from "../routes/queries.js";
import type { Broadcast } from "../ws/snapshots.js";
import type { LoopLike } from "./driver.js";
import { driveSimulationWithScenario } from "./driver.js";
import type { RfidSimConfig } from "@mm/simulation";
import type { DetectionConfig } from "@mm/projections";

/** Options for {@link SimController}. */
export interface SimControllerOptions {
  /** The live Postgres handle (event store + projections). */
  readonly db: ApiDb;
  /** The seed used by the baseline sim (injected scenarios use the same seed + knobs). */
  readonly seed: number;
  /**
   * How many additional ticks to drive when a scenario is injected.
   * A small window (e.g., 5–10 ticks) is enough to trigger one optimizer epoch
   * and produce visible plan changes for the demo.
   * @deprecated This field is no longer used to drive sim ticks; the scenario
   * delta path (FIX F) drives only the additive events. It is kept for API
   * compatibility and used as the `durationTicks` base window for `applyScenario`.
   */
  readonly reoptTicks: number;
  /**
   * FIX F: The total number of ticks the initial baseline sim was driven for.
   * Used to compute the full base stream so `applyScenario` has the correct
   * window (same as the initial sim), AND to derive a `scenarioEpochMs` that
   * is guaranteed to be beyond any epoch the optimizer has already processed.
   *
   * Must match the `durationTicks` passed to `driveSimulation` in `main.ts`.
   * Default: `reoptTicks` (backward-compatible; upgrade to the full tick count
   * by setting this explicitly from the server composition root).
   */
  readonly baselineTicks?: number;
  /** RFID config (passed through to the sim). */
  readonly rfid?: Partial<RfidSimConfig>;
  /** Detection config (passed through to the sim). */
  readonly detection?: DetectionConfig;
  /** The rolling optimizer loop (fired per tick during re-opt). `undefined` = no opt. */
  readonly loop: LoopLike | undefined;
  /** The ws broadcast function (fires per tick). `undefined` = no push. */
  readonly broadcast: Broadcast | undefined;
}

/**
 * The mutable sim state + scenario controller.
 *
 * Thread-safety: in Node.js single-threaded model this is safe — a second
 * `injectScenario` call while the first is still running (async) queues behind
 * the event loop; the last applied knobs win (last-write-wins, audit-trail in
 * the event store).
 */
export class SimController {
  private readonly opts: SimControllerOptions;
  private currentKnobs: ScenarioKnobs | undefined = undefined;

  constructor(opts: SimControllerOptions) {
    this.opts = opts;
  }

  /** Returns the currently-active scenario knobs (or `undefined` for baseline). */
  currentScenario(): ScenarioKnobs | undefined {
    return this.currentKnobs;
  }

  /**
   * Inject new scenario knobs and immediately drive a short re-opt window on the
   * current DB state. The rolling optimizer runs per tick via the injected `loop`,
   * producing updated recommendations visible at `GET /optimizer/recommendations`.
   * The ws broadcast fires per tick so the plan change is visible to ws clients.
   *
   * Determinism: the re-opt is seeded (same `seed + knobs` ⇒ same stream).
   */
  async injectScenario(knobs: ScenarioKnobs): Promise<void> {
    this.currentKnobs = knobs;
    // Drive a short window with the new knobs applied on the current DB state.
    // The loop (rolling optimizer) fires per tick, re-optimizing the affected
    // scope — the keystone: knob change ⇒ scoped re-opt ⇒ pushed tick delta.
    // Use spread to respect exactOptionalPropertyTypes: only include optional fields
    // when they are defined, so undefined is never assigned to optional-only fields.
    // FIX F: use the FULL baseline tick count (not just reoptTicks) as the
    // `durationTicks` for the base-stream generation, so `scenarioEpochMs`
    // is computed from the actual end of the full baseline run — guaranteeing
    // it falls BEYOND any epoch the optimizer has already memoized.
    const fullTicks = this.opts.baselineTicks ?? this.opts.reoptTicks;
    await driveSimulationWithScenario({
      db: this.opts.db,
      seed: this.opts.seed,
      durationTicks: fullTicks,
      scenario: knobs,
      broadcast: this.opts.broadcast,
      ...(this.opts.rfid !== undefined ? { rfid: this.opts.rfid } : {}),
      ...(this.opts.detection !== undefined ? { detection: this.opts.detection } : {}),
      ...(this.opts.loop !== undefined ? { loop: this.opts.loop } : {}),
    });
  }
}
