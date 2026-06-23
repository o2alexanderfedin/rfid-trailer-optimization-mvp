import { z } from "zod";

import type { HosClock } from "./entities/index.js";

/**
 * Shared Hours-of-Service contract (v1.2 HOS-01): the SINGLE source of truth for
 * the US FMCSA (49 CFR Part 395) duty limits, expressed as integer-minute
 * clocks. Lives in `@mm/domain` — the zero-(workspace-)dep leaf both
 * `@mm/simulation` and `@mm/optimizer` import — so the simulator's HOS accrual
 * and the optimizer's HOS feasibility check read the SAME limits without a
 * circular dependency (DRY). Mirrors the {@link TimingConfig} /
 * {@link DEFAULT_TIMING_CONFIG} pattern in `timing.ts`.
 *
 * All values are MINUTES (1 sim tick = 1 minute). This module is PURE: no clock,
 * no RNG, no I/O. The forward-labeling HOS ENGINE that consumes this config is
 * Phase 10 — this phase only defines the constants.
 */

/**
 * Injectable (DIP) HOS configuration — the full FMCSA property-carrying CMV
 * rule set as integer-minute limits. Tests / scenarios may pass an override to
 * pin or relax the limits; the engine uses {@link DEFAULT_HOS_CONFIG} when none
 * is supplied.
 *
 * Rule → field map (citations in `.planning/research/v1.2-DRIVER-HOS-GROUNDING.md`):
 *  - `395.3(a)(3)(i)` 11h driving limit            → `maxDriveMin`
 *  - `395.3(a)(2)`    14h on-duty window (ABSOLUTE) → `dutyWindowMin`
 *  - `395.3(a)(3)(ii)` 30-min break after 8h drive → `breakAfterDriveMin` / `minBreakMin`
 *  - `395.3(a)(1)`    10h off-duty reset           → `resetOffDutyMin`
 *  - `395.3(b)`       70h/8-day weekly cap         → `weeklyCapMin`
 *  - `395.3(c)`       34h restart                  → `restartMin`
 *  - `395.1(g)`       sleeper-berth 7/3 & 8/2 split→ the four `sleeperBerth*` params
 */
export interface HosConfig {
  /** 11h driving limit — max minutes DRIVING after a 10h reset (`395.3(a)(3)(i)`). */
  readonly maxDriveMin: number;
  /**
   * 14h on-duty window (`395.3(a)(2)`) — ELAPSED wall-clock, modeled as an
   * ABSOLUTE deadline (`comeOnDuty + dutyWindowMin`), NOT a pausing counter.
   */
  readonly dutyWindowMin: number;
  /** Driving cap before a break is due — 8h cumulative driving (`395.3(a)(3)(ii)`). */
  readonly breakAfterDriveMin: number;
  /** Minimum qualifying break length — 30 min (`395.3(a)(3)(ii)`). */
  readonly minBreakMin: number;
  /** 10h consecutive off-duty that resets the 11h + 14h clocks (`395.3(a)(1)`). */
  readonly resetOffDutyMin: number;
  /** 70h/8-day rolling ON-DUTY cap (`395.3(b)`). */
  readonly weeklyCapMin: number;
  /** 34h+ off-duty that zeroes the weekly counter (`395.3(c)`). */
  readonly restartMin: number;
  /** Sleeper-berth split — LONG period of the 7/3 variant (7h = 420) (`395.1(g)`). */
  readonly sleeperBerthLongMin: number;
  /** Sleeper-berth split — SHORT period of the 7/3 variant (3h = 180). */
  readonly sleeperBerthShortMin: number;
  /** Sleeper-berth split — LONG period of the 8/2 variant (8h = 480). */
  readonly sleeperBerthAltLongMin: number;
  /** Sleeper-berth split — SHORT period of the 8/2 variant (2h = 120). */
  readonly sleeperBerthAltShortMin: number;
}

/**
 * Runtime validator for {@link HosConfig}: every limit is a POSITIVE integer
 * minute count (zero / fractional / negative rejected at the boundary). Strict,
 * so an unexpected field is a hard error. Used by tests and any
 * config-from-JSON ingestion path.
 */
export const hosConfigSchema = z
  .object({
    maxDriveMin: z.number().int().positive(),
    dutyWindowMin: z.number().int().positive(),
    breakAfterDriveMin: z.number().int().positive(),
    minBreakMin: z.number().int().positive(),
    resetOffDutyMin: z.number().int().positive(),
    weeklyCapMin: z.number().int().positive(),
    restartMin: z.number().int().positive(),
    sleeperBerthLongMin: z.number().int().positive(),
    sleeperBerthShortMin: z.number().int().positive(),
    sleeperBerthAltLongMin: z.number().int().positive(),
    sleeperBerthAltShortMin: z.number().int().positive(),
  })
  .strict();

/**
 * The default full-FMCSA limits (minutes), mirroring the
 * {@link DEFAULT_TIMING_CONFIG} convention. The headline numbers: 11h drive,
 * 14h window, 30-min break after 8h, 10h reset, 70h/8-day cap, 34h restart, plus
 * the 7/3 (420+180) and 8/2 (480+120) sleeper-berth split periods.
 */
export const DEFAULT_HOS_CONFIG: HosConfig = {
  maxDriveMin: 660, // 11h driving limit
  dutyWindowMin: 840, // 14h on-duty window (absolute deadline)
  breakAfterDriveMin: 480, // 8h driving before a break is due
  minBreakMin: 30, // 30-min qualifying break
  resetOffDutyMin: 600, // 10h off-duty reset
  weeklyCapMin: 4200, // 70h / 8-day rolling on-duty cap
  restartMin: 2040, // 34h restart
  sleeperBerthLongMin: 420, // 7/3 split — 7h berth period
  sleeperBerthShortMin: 180, // 7/3 split — 3h period
  sleeperBerthAltLongMin: 480, // 8/2 split — 8h berth period
  sleeperBerthAltShortMin: 120, // 8/2 split — 2h period
};

// ===========================================================================
// Phase-10 forward-labeling HOS ENGINE (HOS-02 / HOS-03)
//
// The pure, deterministic engine that consumes {@link HosConfig} + an
// {@link HosClock} and turns a driving leg of N minutes into the legal sequence
// of duty segments + the advanced clock. This is the SINGLE source of truth the
// simulator (Phase 11) and the optimizer (Phase 16) both call (DRY): the sim
// advances driver state with it; the optimizer calls the SAME function as a
// "rest-as-time" feasibility/insertion check — no rewrite.
//
// PURITY (the keystone): no RNG, no I/O, no `Date.now()`. Every instant is
// passed in as an ISO `occurredAt`, reduced internally to integer epoch-minutes
// (`Date.parse` reads the *argument*, never the wall clock). Integer-minute math
// throughout. Mirrors the pure-function convention of {@link expectedMinutes} in
// `timing.ts`. Identical inputs ⇒ identical output (property-tested).
//
// THE 14-HOUR WINDOW IS ELAPSED WALL-CLOCK. It is modeled as an ABSOLUTE
// deadline (`dutyWindowStartAt + dutyWindowMin`), NEVER a pausing counter — a
// counter would silently pause during the 30-min break and dock dwell and
// overstate legal drive time (49 CFR §395.3(a)(2)). Only a 10h off-duty rest, a
// 34h restart, or a completed sleeper-berth split moves the window start; a
// break does NOT. (See the explicit non-pause test in
// `test/hos-engine.unit.test.ts`.)
// ===========================================================================

/** One minute expressed in milliseconds (the only time-unit conversion). */
const MS_PER_MINUTE = 60_000;

/**
 * Pure ISO-8601 → integer epoch-minute conversion. Reads ONLY the supplied
 * stamp (`Date.parse`), never the wall clock, so the engine stays deterministic.
 * Throws on an unparseable / non-integer-minute stamp (the sim only emits exact
 * minute stamps, `1 tick = 1 min`).
 *
 * @param iso An ISO-8601 instant (e.g. an event `occurredAt`).
 * @returns Whole minutes since the Unix epoch.
 */
export function isoToEpochMinutes(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new RangeError(`isoToEpochMinutes: unparseable ISO stamp "${iso}"`);
  }
  return Math.trunc(ms / MS_PER_MINUTE);
}

/** Pure integer-epoch-minute → ISO-8601 conversion (inverse of {@link isoToEpochMinutes}). */
export function epochMinutesToIso(minutes: number): string {
  return new Date(minutes * MS_PER_MINUTE).toISOString();
}

/**
 * One labeled interval of a driver's duty timeline produced by the engine. The
 * `kind` is the closed four-state FMCSA taxonomy; `minutes` is always a positive
 * integer count.
 *
 *  - `drive`   — time spent DRIVING (decrements the 11h + 8h clocks).
 *  - `break`   — a ≥30-min non-driving interruption (resets the 8h clock only).
 *  - `rest`    — a 10h off-duty reset OR a 34h restart (resets the per-shift /
 *                weekly clocks; advances the 14h window).
 *  - `sleeper` — a qualifying sleeper-berth period (one half of a 7/3 or 8/2
 *                split); the paired period does NOT count against the 14h window.
 */
export interface DutySegment {
  readonly kind: "drive" | "break" | "rest" | "sleeper";
  readonly minutes: number;
}

/** Result of {@link applyDrivingLeg}: the labeled segments + the advanced clock. */
export interface DrivingLegResult {
  /** The legal duty timeline for the leg, in chronological order. */
  readonly segments: readonly DutySegment[];
  /** The {@link HosClock} after the whole leg (and any inserted breaks/rests). */
  readonly clock: HosClock;
}

/** Result of {@link applySleeperBerthPeriod}: the advanced clock + reset flag. */
export interface SleeperBerthResult {
  /** The {@link HosClock} after accruing the sleeper period. */
  readonly clock: HosClock;
  /** True iff this period COMPLETED a qualifying 7/3 or 8/2 split (10h reset). */
  readonly reset: boolean;
}

/**
 * The 14h ABSOLUTE deadline, in epoch-minutes: `dutyWindowStartAt + dutyWindowMin`.
 * The window is elapsed wall-clock, so this is a fixed instant, not a counter.
 */
function dutyWindowDeadline(clock: HosClock, config: HosConfig): number {
  return isoToEpochMinutes(clock.dutyWindowStartAt) + config.dutyWindowMin;
}

/**
 * The headline "remaining legal drive minutes" number (HOS-03), clamped at 0:
 *
 * ```
 * clamp≥0( min(
 *   maxDriveMin       − driveTodayMin,        // 11h driving limit
 *   dutyWindowDeadline − now,                  // 14h ABSOLUTE wall-clock window
 *   breakAfterDriveMin − sinceLastBreakMin     // 8h-break clock
 * ) )
 * ```
 *
 * Pure: identical `(clock, config, now)` ⇒ identical result.
 *
 * @param clock  The driver's HOS clock.
 * @param config The FMCSA limits.
 * @param now    The current instant in epoch-MINUTES (e.g. `isoToEpochMinutes(occurredAt)`).
 */
export function remainingLegalDriveMinutes(
  clock: HosClock,
  config: HosConfig,
  now: number,
): number {
  const byDrive = config.maxDriveMin - clock.driveTodayMin;
  const byWindow = dutyWindowDeadline(clock, config) - now;
  const byBreak = config.breakAfterDriveMin - clock.sinceLastBreakMin;
  return Math.max(0, Math.min(byDrive, byWindow, byBreak));
}

/**
 * The "may drive now" predicate (HOS-03): legal to start/continue driving iff
 * there are remaining legal drive minutes AND the rolling 70h/8-day on-duty cap
 * has NOT been reached.
 *
 * @param now The current instant in epoch-MINUTES.
 */
export function mayDriveNow(clock: HosClock, config: HosConfig, now: number): boolean {
  return (
    remainingLegalDriveMinutes(clock, config, now) > 0 &&
    clock.weeklyOnDutyMin < config.weeklyCapMin
  );
}

/**
 * Advance the window-resetting clocks for a full off-duty reset (a 10h rest or a
 * 34h restart). The new shift starts at `atMin + restMin`; the per-shift clocks
 * zero, the sleeper accumulators clear. A 34h restart additionally zeroes the
 * weekly counter.
 */
function applyOffDutyReset(
  clock: HosClock,
  atMin: number,
  restMin: number,
  isRestart: boolean,
): HosClock {
  const startAt = epochMinutesToIso(atMin + restMin);
  return {
    driveTodayMin: 0,
    sinceLastBreakMin: 0,
    dutyWindowStartAt: startAt,
    comeOnDutyAt: startAt,
    weeklyOnDutyMin: isRestart ? 0 : clock.weeklyOnDutyMin,
    sleeperBerthLongMin: 0,
    sleeperBerthShortMin: 0,
  };
}

/**
 * The pure forward-labeling HOS engine (HOS-02). Walks a driving leg of
 * `legMinutes` forward in a minute budget; before each driving chunk it asks
 * {@link remainingLegalDriveMinutes} which clock binds first and inserts the
 * SMALLEST legal rest ("rest-as-time"):
 *
 *  - 8h-break clock binds  → a 30-min `break` (resets the 8h clock only; the 14h
 *    window does NOT pause).
 *  - 70h weekly cap binds  → a 34h `rest` restart (zeroes the weekly counter).
 *  - 11h limit OR the 14h ABSOLUTE window binds → a 10h off-duty `rest` (resets
 *    the per-shift clocks and moves the window start forward).
 *
 * Returns the legal `segments` (chronological) and the advanced `clock`. Does NOT
 * mutate the input clock. Deterministic: identical inputs ⇒ identical output.
 *
 * The optimizer reuses this UNCHANGED as a feasibility check: a leg is HOS-legal
 * with no relay iff the returned segments contain no `rest`/`sleeper` insertion
 * (it can also read the inserted rest minutes as added `serviceMin`).
 *
 * @param clock      The driver's HOS clock at the start of the leg.
 * @param config     The FMCSA limits.
 * @param legMinutes Whole minutes of DRIVING the leg requires (`>= 0`).
 * @param occurredAt The ISO instant the leg begins (event `occurredAt`).
 */
export function applyDrivingLeg(
  clock: HosClock,
  config: HosConfig,
  legMinutes: number,
  occurredAt: string,
): DrivingLegResult {
  if (!Number.isInteger(legMinutes) || legMinutes < 0) {
    throw new RangeError(
      `applyDrivingLeg: legMinutes must be a non-negative integer, got ${legMinutes}`,
    );
  }

  const segments: DutySegment[] = [];
  let current: HosClock = clock;
  let nowMin = isoToEpochMinutes(occurredAt);
  let remaining = legMinutes;

  while (remaining > 0) {
    // The weekly 70h/8-day cap is a HARD gate that {@link remainingLegalDriveMinutes}
    // deliberately excludes (HOS-03), so check it FIRST: a depleted weekly counter
    // is only cured by a 34h restart, regardless of the per-shift clocks.
    if (current.weeklyOnDutyMin >= config.weeklyCapMin) {
      segments.push({ kind: "rest", minutes: config.restartMin });
      current = applyOffDutyReset(current, nowMin, config.restartMin, true);
      nowMin += config.restartMin;
      continue;
    }

    const canDrive = remainingLegalDriveMinutes(current, config, nowMin);

    if (canDrive <= 0) {
      // A per-shift clock has run out — insert the smallest legal rest and retry.
      const byBreak = config.breakAfterDriveMin - current.sinceLastBreakMin;

      if (byBreak <= 0) {
        // 8h-break clock binds → a 30-min break (resets the 8h clock ONLY; the
        // 14h window keeps elapsing — it is NOT paused).
        segments.push({ kind: "break", minutes: config.minBreakMin });
        current = { ...current, sinceLastBreakMin: 0 };
        nowMin += config.minBreakMin;
      } else {
        // 11h limit or the 14h ABSOLUTE window binds → a 10h off-duty reset.
        segments.push({ kind: "rest", minutes: config.resetOffDutyMin });
        current = applyOffDutyReset(current, nowMin, config.resetOffDutyMin, false);
        nowMin += config.resetOffDutyMin;
      }
      continue;
    }

    // Drive the largest legal chunk that fits the remaining leg AND keeps the
    // rolling weekly on-duty total at/under the 70h/8-day cap (so the cap binds
    // exactly, never overshoots, before the next-iteration restart gate fires).
    const byWeekly = config.weeklyCapMin - current.weeklyOnDutyMin;
    const chunk = Math.min(canDrive, remaining, byWeekly);
    segments.push({ kind: "drive", minutes: chunk });
    current = {
      ...current,
      driveTodayMin: current.driveTodayMin + chunk,
      sinceLastBreakMin: current.sinceLastBreakMin + chunk,
      weeklyOnDutyMin: current.weeklyOnDutyMin + chunk,
    };
    nowMin += chunk;
    remaining -= chunk;
  }

  return { segments, clock: current };
}

/**
 * Apply ONE sleeper-berth period toward a 7/3 or 8/2 split (49 CFR §395.1(g)),
 * the highest-complexity HOS provision (the split makes the 14h window
 * NON-MONOTONIC). A driver may break the required 10h reset into two qualifying
 * periods — `7h berth + 3h` (7/3) or `8h berth + 2h` (8/2) — where neither
 * period is < 2h, the total is ≥ 10h, and at least one period is ≥ 7h in the
 * berth. **Neither qualifying period counts against the 14h window**, so each
 * such period pushes the window start forward by its own duration.
 *
 * Semantics:
 *  - A period `>= sleeperBerthShortMin`-equivalent (the smaller of the 7/3 / 8/2
 *    short periods, i.e. `>= 2h`) is a QUALIFYING period; shorter periods do not
 *    qualify and leave the accumulators unchanged.
 *  - A `>= 7h` period fills the LONG (berth) accumulator; a 2–<7h period fills
 *    the SHORT accumulator.
 *  - When a LONG (`>= 7h`) and a SHORT (`>= 2h`) period have BOTH been seen and
 *    their combined minutes are `>= resetOffDutyMin` (10h), the split COMPLETES:
 *    the per-shift clocks reset (like a full 10h off-duty) and the accumulators
 *    clear (`reset: true`).
 *  - Every qualifying period advances `dutyWindowStartAt` by its own duration
 *    (the period does not count against the window) — the non-monotonic push.
 *
 * Pure & deterministic; does not mutate the input clock.
 *
 * @param clock        The driver's HOS clock.
 * @param config       The FMCSA limits (carries the 7/3 & 8/2 split params).
 * @param periodMinutes Whole minutes of this off-duty / sleeper period (`>= 0`).
 * @param occurredAt   The ISO instant the period begins.
 */
export function applySleeperBerthPeriod(
  clock: HosClock,
  config: HosConfig,
  periodMinutes: number,
  occurredAt: string,
): SleeperBerthResult {
  if (!Number.isInteger(periodMinutes) || periodMinutes < 0) {
    throw new RangeError(
      `applySleeperBerthPeriod: periodMinutes must be a non-negative integer, got ${periodMinutes}`,
    );
  }

  // The shortest qualifying split period is the smaller of the two SHORT periods
  // (8/2 → 2h is the floor); a period below it does not qualify (FMCSA: neither
  // period < 2h).
  const minQualifyingMin = Math.min(
    config.sleeperBerthShortMin,
    config.sleeperBerthAltShortMin,
  );
  if (periodMinutes < minQualifyingMin) {
    return { clock, reset: false }; // non-qualifying — accumulators untouched.
  }

  // A qualifying period does NOT count against the 14h window → push the window
  // start forward PAST the period (the non-monotonic window). The period is
  // reckoned from whichever is later — the existing window start or when the
  // period actually begins (`occurredAt`) — so a deferred sleeper period excludes
  // exactly its own elapsed minutes.
  const periodStartMin = Math.max(
    isoToEpochMinutes(clock.dutyWindowStartAt),
    isoToEpochMinutes(occurredAt),
  );
  let next: HosClock = {
    ...clock,
    dutyWindowStartAt: epochMinutesToIso(periodStartMin + periodMinutes),
  };

  // A >=7h period is the LONG (berth) half; a 2–<7h period is the SHORT half.
  const isLong = periodMinutes >= config.sleeperBerthLongMin;
  if (isLong) {
    next = { ...next, sleeperBerthLongMin: next.sleeperBerthLongMin + periodMinutes };
  } else {
    next = { ...next, sleeperBerthShortMin: next.sleeperBerthShortMin + periodMinutes };
  }

  // The split COMPLETES when both halves are present and total >= 10h.
  const hasLong = next.sleeperBerthLongMin >= config.sleeperBerthLongMin;
  const hasShort = next.sleeperBerthShortMin >= minQualifyingMin;
  const total = next.sleeperBerthLongMin + next.sleeperBerthShortMin;
  if (hasLong && hasShort && total >= config.resetOffDutyMin) {
    // Completed split = a 10h reset of the per-shift clocks; accumulators clear.
    // (The window start was already advanced by both qualifying periods above.)
    next = {
      ...next,
      driveTodayMin: 0,
      sinceLastBreakMin: 0,
      comeOnDutyAt: next.dutyWindowStartAt,
      sleeperBerthLongMin: 0,
      sleeperBerthShortMin: 0,
    };
    return { clock: next, reset: true };
  }

  return { clock: next, reset: false };
}
