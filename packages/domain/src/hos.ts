import { z } from "zod";

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
