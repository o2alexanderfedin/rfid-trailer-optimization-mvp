/**
 * Plan 19-08 Task D — the SINGLE SOURCE OF TRUTH for the simulation epoch.
 *
 * The virtual clock starts here; there is NO wall-clock read anywhere in the
 * engine (the determinism keystone). Every consumer — the engine clock, the ws
 * `simDay`/`simMs` derivation, and tests — imports these constants instead of
 * re-typing the literal, so they can never drift apart.
 */

/** The seeded domain epoch (ISO-8601). The clock is anchored here. */
export const EPOCH_ISO = "2026-04-01T00:00:00.000Z";

/** The seeded domain epoch as Unix-epoch milliseconds (`Date.parse(EPOCH_ISO)`). */
export const EPOCH_MS = Date.parse(EPOCH_ISO);

/** Domain ms per tick. 1 tick = 1 minute of simulated time. */
export const MS_PER_TICK = 60_000;
