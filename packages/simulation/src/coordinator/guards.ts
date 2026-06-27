import type { Rng } from "../rng.js";
import {
  BACKOFF_BASE_SIM_MS,
  BACKOFF_CAP_SIM_MS,
  BACKOFF_JITTER_SIM_MS,
  HYSTERESIS_DWELL_SIM_MS,
  LEASE_SIM_MS,
  REJECT_COOLDOWN_K,
  SUGGESTION_TTL_SIM_MS,
} from "./constants.js";

/**
 * Phase-25 COORD-04 — the five anti-oscillation / anti-deadlock guard predicates.
 *
 * Each guard is a PURE, sim-time function: it takes a guard-state value (plain,
 * serializable data) + `nowSimMs` (the virtual clock, NEVER `Date.now`) (+ a seeded
 * `Rng` for the backoff jitter, NEVER `Math.random`) and returns a suppress/allow
 * decision and/or a NEW state value (no mutation — the reducer style, mirroring the
 * rest of `coordinator/**`). The engine (Plan 04 Task 2) threads these between
 * `decideCoordinatorSuggestions` (candidate generation) and emit: a candidate that
 * fails ANY guard is suppressed (not emitted). The reject-pruning + backoff counts
 * are advanced when a `SuggestionRejected` is observed in the handshake.
 *
 * DETERMINISM (DET-03): no wall clock, no unseeded random, no engine read. Every
 * guard's output is a total function of its (data) inputs, so the coordinator-on
 * golden (Plan 05) is byte-stable. The state shapes are plain serializable data so
 * Plan 05 can persist them into `SerializedWorldState` for continuation-equivalence.
 *
 * STATE-SHAPE CONVENTION: the guard state lives in in-engine Maps keyed by a stable
 * composite string (e.g. `${coordinatorId}|${targetAgentId}|${kind}` for the
 * per-option guards, `${targetAgentId}` for the lease/hysteresis). Each value is a
 * plain integer (a sim-time marker / a count) — the smallest serializable shape.
 */

// ===========================================================================
// GUARD 1 — HYSTERESIS DEAD-BAND
// ===========================================================================

/**
 * Has the triggering metric persisted ABOVE threshold long enough to allow a NEW
 * suggestion? A candidate passes hysteresis only when the metric has been
 * continuously above threshold for at least `HYSTERESIS_DWELL_SIM_MS`.
 *
 * `metricAboveSinceSimMs` is the sim-time the metric FIRST crossed (and has stayed)
 * above threshold for this (target, kind) — or `null` when the metric is currently
 * below threshold (no active breach). A transient spike (breach cleared before the
 * dwell elapses) resets the marker to `null`, so it never passes.
 *
 * @returns `true` when a sustained breach has dwelled ≥ the dead-band ⇒ allow.
 */
export function passesHysteresis(
  metricAboveSinceSimMs: number | null,
  nowSimMs: number,
): boolean {
  if (metricAboveSinceSimMs === null) return false;
  return nowSimMs - metricAboveSinceSimMs >= HYSTERESIS_DWELL_SIM_MS;
}

/**
 * Advance the hysteresis "metric-above-since" marker for one (target, kind) given
 * whether the metric is currently above threshold. Pure: returns the NEW marker.
 *
 * - metric below threshold ⇒ `null` (breach cleared; the dwell resets).
 * - metric above threshold + no prior marker ⇒ `nowSimMs` (breach STARTS now).
 * - metric above threshold + an existing marker ⇒ the marker is RETAINED (the
 *   breach is continuing; the dwell keeps accruing).
 */
export function updateHysteresisMarker(
  prevMarker: number | null,
  metricAboveThreshold: boolean,
  nowSimMs: number,
): number | null {
  if (!metricAboveThreshold) return null;
  return prevMarker ?? nowSimMs;
}

// ===========================================================================
// GUARD 2 — SEEDED-JITTER EXPONENTIAL BACKOFF
// ===========================================================================

/**
 * The next "backoff-until" sim-time for an option after its `rejectionCount`-th
 * rejection: `nowSimMs + min(BASE * 2^(count-1), CAP) + jitter`, where `jitter` is
 * a SEEDED draw in `[0, BACKOFF_JITTER_SIM_MS)` from the per-center coordinator
 * substream (`rng.int`, never `Math.random`). Monotonic-exponential in
 * `rejectionCount` (capped). `rejectionCount` must be ≥ 1 (the count AFTER a
 * rejection); a count ≤ 0 yields `nowSimMs` (no backoff).
 *
 * Pure given (count, nowSimMs, rng-state): the same rng position ⇒ the same jitter
 * ⇒ the same backoff-until. The jitter is the ONLY stochastic input (DET-03).
 */
export function nextBackoffUntil(
  rejectionCount: number,
  nowSimMs: number,
  rng: Rng,
): number {
  if (rejectionCount <= 0) return nowSimMs;
  // Exponential growth (capped): BASE * 2^(count-1), clamped to CAP. Computed with
  // integer shifts of the tick-multiple base; a large count saturates at CAP.
  const exponent = rejectionCount - 1;
  // Guard the shift: 2^exponent overflows a 32-bit int past ~30, but the cap clamps
  // long before that — once `BASE << exponent` would exceed CAP we just use CAP.
  const uncapped =
    exponent >= 31 ? BACKOFF_CAP_SIM_MS : BACKOFF_BASE_SIM_MS * 2 ** exponent;
  const delay = Math.min(uncapped, BACKOFF_CAP_SIM_MS);
  const jitter = rng.int(BACKOFF_JITTER_SIM_MS);
  return nowSimMs + delay + jitter;
}

/**
 * Is an option still IN backoff? True while `nowSimMs < backoffUntilSimMs`. A
 * `backoffUntilSimMs` of `null`/`0` (never backed off) is not in backoff.
 */
export function inBackoff(backoffUntilSimMs: number | null, nowSimMs: number): boolean {
  if (backoffUntilSimMs === null) return false;
  return nowSimMs < backoffUntilSimMs;
}

// ===========================================================================
// GUARD 3 — SIM-TIME TTL
// ===========================================================================

/**
 * Has a suggestion expired? True once `nowSimMs >= issuedAtSimMs + ttlSimMs`. An
 * expired pending suggestion self-destructs (it is dropped, never acted on). Pure
 * sim-time arithmetic (DET-03). `ttlSimMs` defaults to the named
 * `SUGGESTION_TTL_SIM_MS` so a caller can pass the per-suggestion stamp or rely on
 * the envelope.
 */
export function isExpired(
  issuedAtSimMs: number,
  nowSimMs: number,
  ttlSimMs: number = SUGGESTION_TTL_SIM_MS,
): boolean {
  return nowSimMs >= issuedAtSimMs + ttlSimMs;
}

// ===========================================================================
// GUARD 4 — SINGLE-OWNER LEASE PER AGENT
// ===========================================================================

/** A single-owner lease on a target: which coordinator holds it, until when (sim-ms). */
export interface CoordinatorLease {
  readonly coordinatorId: string;
  readonly expiresAtSimMs: number;
}

/**
 * May `coordinatorId` advise this target right now? A target is available when
 * there is NO live lease, the live lease is held by THIS coordinator (re-advise
 * own), or the lease has EXPIRED (`nowSimMs >= expiresAtSimMs`, reclaimable). A
 * live lease held by ANOTHER coordinator suppresses (the single-owner guard,
 * Pitfall 11 conflict).
 */
export function leaseAvailable(
  lease: CoordinatorLease | null,
  coordinatorId: string,
  nowSimMs: number,
): boolean {
  if (lease === null) return true;
  if (lease.coordinatorId === coordinatorId) return true;
  return nowSimMs >= lease.expiresAtSimMs;
}

/**
 * Acquire a fresh lease for `coordinatorId` on a target, valid for `LEASE_SIM_MS`
 * from `nowSimMs`. Pure: returns the NEW lease value (the caller stores it). Only
 * call after {@link leaseAvailable} returned true.
 */
export function acquireLease(coordinatorId: string, nowSimMs: number): CoordinatorLease {
  return { coordinatorId, expiresAtSimMs: nowSimMs + LEASE_SIM_MS };
}

// ===========================================================================
// GUARD 5 — REJECT-PATH PRUNING
// ===========================================================================

/**
 * Is a (target, kind) option PRUNED — rejected ≥ `K` times, so the coordinator must
 * stop re-offering it (the cooldown)? `K` defaults to the named `REJECT_COOLDOWN_K`.
 * This is the events-per-tick bound under an all-reject scenario (Pitfall 10 Zeno).
 */
export function isPruned(rejectionCount: number, k: number = REJECT_COOLDOWN_K): boolean {
  return rejectionCount >= k;
}

/**
 * Record one more rejection of an option ⇒ the new rejection count. Pure (a +1).
 * The engine advances this when a `SuggestionRejected` is observed in the handshake.
 */
export function recordReject(rejectionCount: number): number {
  return rejectionCount + 1;
}

/**
 * Clear the prune (and any accrued rejection count) for an option on a shift / zone
 * change — a `centerOf` change for the agent re-opens every option for it. Pure:
 * returns the reset count (`0`). A thin, named helper so the engine's
 * zone-change-clears-prune intent is explicit (mirrors the OPT-06 freeze-window
 * reset discipline).
 */
export function clearPruneOnZoneChange(): number {
  return 0;
}
