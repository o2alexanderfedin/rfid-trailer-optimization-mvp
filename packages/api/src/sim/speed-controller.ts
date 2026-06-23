/**
 * SpeedController — the pure, single source of truth for the demo's
 * "speed of time" (multiplier ⇆ tickInterval ⇆ simSpeed, plus pause).
 *
 * The controller holds NO I/O and NO timers. It is read by three collaborators:
 *   - the paced driver       → `getTickIntervalMs()` / `isPaused()` per tick,
 *   - the snapshot broadcast → `snapshot()` stamped on every envelope + `noteSimMs`,
 *   - the POST /api/sim/speed route → `apply({multiplier?, paused?})`.
 *
 * Speed model (locked — see CLAUDE.md / PLAN.md):
 *   - default `tickIntervalMs = 500` ⇒ multiplier **1×** (= 120× sim compression).
 *   - multiplier `m`: `tickIntervalMs = defaultIntervalMs / m`, with
 *     `m` clamped to `[0.25, 64]` and the resulting interval clamped to
 *     `[minIntervalMs, maxIntervalMs]` (= `[5, 2000]`) so it is NEVER 0.
 *   - `simSpeed = msPerTick / tickIntervalMs` (= 120 at the default), but **0
 *     while paused** so the frontend trailer tween freezes.
 *   - reported `multiplier = defaultIntervalMs / tickIntervalMs`.
 *
 * DETERMINISM: `tickIntervalMs` and `paused` are PRESENTATION pacing only — they
 * never enter the sim engine, the event store, or the optimizer. Same seed ⇒ same
 * event stream regardless of speed (asserted by the driver determinism test).
 */

import type { SimSpeedState } from "../ws/envelope.js";

/** Speed-multiplier bounds (relative to the default 1×). */
const MIN_MULTIPLIER = 0.25;
const MAX_MULTIPLIER = 64;

/** Options for {@link makeSpeedController}. */
export interface SpeedControllerOptions {
  /**
   * Sim-clock milliseconds advanced per tick (= the simulation engine's
   * `MS_PER_TICK`). Drives the frontend `simSpeed = msPerTick / tickIntervalMs`.
   * Default: 60000 (1 tick = 1 sim-minute).
   */
  readonly msPerTick?: number;
  /** The 1× wall-clock tick interval. Default: 500ms (⇒ 120× compression). */
  readonly defaultIntervalMs?: number;
  /** Floor for the tick interval (supports up to the 64× clamp). Default: 5ms (never 0). */
  readonly minIntervalMs?: number;
  /** Ceiling for the tick interval (0.25× clamp). Default: 2000ms. */
  readonly maxIntervalMs?: number;
  /**
   * Fired with the post-mutation `snapshot()` after every state mutator
   * (`setMultiplier`/`setPaused`/`apply`). The composition root wires this to an
   * immediate broadcast so a pause/speed change reflects without waiting for a
   * (possibly paused) next tick. NOT fired by `noteSimMs` (pacing bookkeeping).
   */
  readonly onChange?: (snapshot: SimSpeedState) => void;
}

/** The mutable controller returned by {@link makeSpeedController}. */
export interface SpeedController {
  /** Current wall-clock ms between ticks (read by the paced driver each iteration). */
  getTickIntervalMs(): number;
  /** Whether the driver should hold before the next tick. */
  isPaused(): boolean;
  /** Frontend playback rate (sim-ms per wall-ms); 0 while paused. */
  getSimSpeed(): number;
  /** Immutable snapshot of the full speed state (the wire/route contract). */
  snapshot(): SimSpeedState;
  /** Set the speed multiplier (clamped to [0.25, 64]); fires `onChange`. */
  setMultiplier(multiplier: number): void;
  /** Set the paused flag; fires `onChange`. */
  setPaused(paused: boolean): void;
  /** Apply multiplier and/or paused atomically; fires `onChange` once. */
  apply(input: { readonly multiplier?: number; readonly paused?: boolean }): void;
  /** Record the latest authoritative sim time (for immediate broadcasts). */
  noteSimMs(simMs: number): void;
  /** The last sim time recorded via {@link noteSimMs}. */
  getLastSimMs(): number;
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Create a new pure speed controller seeded at the default interval (1×).
 */
export function makeSpeedController(
  opts: SpeedControllerOptions = {},
): SpeedController {
  const msPerTick = opts.msPerTick ?? 60_000;
  const defaultIntervalMs = opts.defaultIntervalMs ?? 500;
  const minIntervalMs = opts.minIntervalMs ?? 5;
  const maxIntervalMs = opts.maxIntervalMs ?? 2000;
  const onChange = opts.onChange;

  let tickIntervalMs = defaultIntervalMs;
  let paused = false;
  let lastSimMs = 0;

  /** Map a multiplier onto a clamped, non-zero tick interval. */
  function intervalForMultiplier(multiplier: number): number {
    const m = clamp(multiplier, MIN_MULTIPLIER, MAX_MULTIPLIER);
    // Not rounded to an integer: at the 64× cap the exact interval is 500/64 =
    // 7.8125ms, and rounding would report 62.5× instead of a clean 64×. setTimeout
    // accepts fractional ms; the interval floor still guards against a busy spin.
    const raw = defaultIntervalMs / m;
    return clamp(raw, minIntervalMs, maxIntervalMs);
  }

  function getSimSpeed(): number {
    return paused ? 0 : msPerTick / tickIntervalMs;
  }

  function snapshot(): SimSpeedState {
    return {
      multiplier: defaultIntervalMs / tickIntervalMs,
      tickIntervalMs,
      simSpeed: getSimSpeed(),
      paused,
    };
  }

  function fireChange(): void {
    onChange?.(snapshot());
  }

  return {
    getTickIntervalMs: () => tickIntervalMs,
    isPaused: () => paused,
    getSimSpeed,
    snapshot,
    setMultiplier(multiplier: number): void {
      tickIntervalMs = intervalForMultiplier(multiplier);
      fireChange();
    },
    setPaused(next: boolean): void {
      paused = next;
      fireChange();
    },
    apply(input): void {
      if (input.multiplier !== undefined) {
        tickIntervalMs = intervalForMultiplier(input.multiplier);
      }
      if (input.paused !== undefined) {
        paused = input.paused;
      }
      fireChange();
    },
    noteSimMs(simMs: number): void {
      lastSimMs = simMs;
    },
    getLastSimMs: () => lastSimMs,
  };
}
