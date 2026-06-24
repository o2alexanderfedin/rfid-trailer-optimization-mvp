/**
 * Shared FUEL contract (SP2 — Meaningful Rest & Fuel Stops, spec §4). The SINGLE
 * source of truth for the deterministic, mileage-triggered fuel model both the
 * simulator (`@mm/simulation`) and the optimizer (`@mm/optimizer`) read — so it
 * lives in `@mm/domain` (the zero-(workspace-)dep leaf) to avoid a circular
 * dependency, mirroring how {@link import("./timing.js").TimingConfig} is shared.
 *
 *  - `@mm/simulation` tracks a per-trailer odometer and, when `enabled`, emits a
 *    located `TruckRefueled` once `milesSinceRefuel` crosses `refuelThresholdMiles`.
 *  - `@mm/optimizer` folds the EXPECTED refuel time into leg timing/feasibility via
 *    `Stop.refuelMin` (`max(restMin, refuelMin)` — no double-count with a rest).
 *
 * DETERMINISM KEYSTONE (spec §4): fuel is OPT-IN and `enabled` DEFAULTS FALSE. With
 * fuel OFF the simulator makes ZERO new RNG draws, emits NO new events, and creates
 * NO projection deltas ⇒ its stream stays BYTE-IDENTICAL to the current golden. This
 * config carries NO RNG and NO geometry — positions are computed by the geo-track
 * projection from the logged leg geometry, never carried on the event payloads.
 *
 * All distances are MILES; all durations are MINUTES (1 sim tick = 1 minute).
 */

/**
 * Injectable (DIP) fuel configuration. Mirrors `RfidSimConfig` / `TimingConfig`:
 * tests may pass an override to pin or widen the tank model; consumers fall back
 * to {@link DEFAULT_FUEL_CONFIG} when none is supplied. `enabled` is OPTIONAL and
 * defaults FALSE (the determinism keystone) so omitting the whole config — or
 * passing the default — keeps the golden stream byte-identical.
 */
export interface FuelConfig {
  /** Master switch. OPTIONAL, DEFAULT FALSE (golden off — zero new RNG/events). */
  readonly enabled?: boolean;
  /** Usable tank capacity in gallons — caps the gallons a single refuel logs. */
  readonly tankCapacityGallons: number;
  /** Fuel economy in miles per gallon (the odometer→gallons divisor). */
  readonly milesPerGallon: number;
  /** Refuel when a trailer's miles-since-last-refuel reach (≥) this threshold. */
  readonly refuelThresholdMiles: number;
  /** Service time a refuel adds (minutes) when NOT overlapped by a co-located rest. */
  readonly refuelTimeMinutes: number;
}

/**
 * The default fuel model (spec §4): a Class-8-realistic ~1,200-mi range at
 * 6.5 mpg with a 150-gal usable tank and a 30-min refuel stop. `enabled: false`
 * is the determinism keystone — the default leaves the golden byte-identical.
 */
export const DEFAULT_FUEL_CONFIG: FuelConfig = {
  enabled: false,
  tankCapacityGallons: 150,
  milesPerGallon: 6.5,
  refuelThresholdMiles: 1200,
  refuelTimeMinutes: 30,
};
