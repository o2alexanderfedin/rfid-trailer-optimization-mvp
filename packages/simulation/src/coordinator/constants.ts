import { MS_PER_TICK } from "../epoch.js";

/**
 * Phase-25 COORD-04 — the NAMED, tunable, sim-time constant envelope for the five
 * anti-oscillation / anti-deadlock coordinator guards.
 *
 * Every constant here is a SIM-TIME quantity (milliseconds-since-epoch deltas, all
 * integral multiples of `MS_PER_TICK`) or a small integer count. NONE is a
 * wall-clock value, a float, or a `Math.random` draw — so each guard that reads
 * these stays pure + deterministic (DET-03). They are the DESIGN-CONSULT Q2
 * envelope (hysteresis dwell ~15 sim-min, TTL ~6 sim-min, lease ~5 sim-min,
 * cooldown K=3, exponential-backoff base/cap) made concrete, and they are BAKED
 * INTO the coordinator-on golden (Plan 05) — so any value change here moves that
 * golden by design.
 *
 * `MS_PER_TICK` is the single tick→sim-ms conversion (1 tick = 1 sim-minute), so
 * "~15 sim-min" is exactly `15 * MS_PER_TICK`. Expressing the envelope as
 * tick-multiples keeps the constants aligned to the coordinator cadence
 * (`COORDINATOR_INTERVAL_TICKS = 5`): a dwell of 15 sim-min spans three coordinator
 * passes, a TTL of 6 sim-min just over one pass, a lease of 5 sim-min exactly one
 * pass — so a guard's window is always an integer number of passes.
 */

/**
 * GUARD 1 — HYSTERESIS DEAD-BAND. A triggering metric (e.g. a next-hub inbound
 * queue above the congestion threshold) must cross the threshold AND PERSIST for at
 * least this many sim-ms before the coordinator may issue a NEW suggestion of that
 * kind for that target. A transient spike that falls back below threshold inside the
 * dwell window emits NOTHING — this is the oscillation damper (Pitfall 11): without
 * a dwell, a metric flickering across the threshold flips an A↔B↔A re-route every
 * pass. ~15 sim-min = 3 coordinator passes of sustained breach.
 */
export const HYSTERESIS_DWELL_SIM_MS = 15 * MS_PER_TICK;

/**
 * GUARD 3 — SIM-TIME TTL. Every suggestion expires at `issuedAtSimMs +
 * SUGGESTION_TTL_SIM_MS`. An unaccepted suggestion that survives to a later pass
 * (a pending entry not drained in its issuing tick) self-destructs once `nowSimMs`
 * passes the expiry — it is dropped, never acted on. ~6 sim-min, just over one
 * coordinator pass; matches the `ttlSimMs` already STAMPED on `ActionSuggested` in
 * Plan 02 (`COORDINATOR_TTL_SIM_MS = 6 * MS_PER_TICK`), kept in lockstep here so the
 * stamped value and the enforced value are the SAME named quantity.
 */
export const SUGGESTION_TTL_SIM_MS = 6 * MS_PER_TICK;

/**
 * GUARD 4 — SINGLE-OWNER LEASE. A coordinator must hold a lease on a target before
 * advising it; the lease is valid for this many sim-ms from acquisition. While a
 * lease is held by coordinator A, a DIFFERENT coordinator B that sees the same
 * target (a boundary truck in transit between regions) is suppressed. ~5 sim-min =
 * exactly one coordinator pass, so a lease covers the gap between consecutive
 * passes; an expired lease is reclaimable by any coordinator.
 */
export const LEASE_SIM_MS = 5 * MS_PER_TICK;

/**
 * GUARD 5 — REJECT-PATH PRUNING. After an agent rejects a specific (target, kind)
 * option this many times, the coordinator STOPS re-offering it (a cooldown) — this
 * is what bounds events-per-tick under an all-reject scenario (Pitfall 10 Zeno
 * livelock): the same ActionSuggested/SuggestionRejected pair cannot repeat forever.
 * The prune is cleared on a shift / zone change (a `centerOf` change for the agent).
 * K = 3 (the DESIGN-CONSULT cooldown).
 */
export const REJECT_COOLDOWN_K = 3;

/**
 * GUARD 2 — SEEDED-JITTER EXPONENTIAL BACKOFF, base delay. After the n-th rejection
 * of an option the backoff delay is `BACKOFF_BASE_SIM_MS * 2^(n-1)` plus a seeded
 * jitter, capped at `BACKOFF_CAP_SIM_MS`. The option is suppressed until
 * `nowSimMs >= backoffUntilSimMs`. The doubling makes a repeatedly-rejected option
 * back off ever-further (so a transiently-infeasible option is retried soon but a
 * persistently-infeasible one is retried rarely), while the cap prevents an
 * unbounded delay. Base ~1 sim-min.
 */
export const BACKOFF_BASE_SIM_MS = 1 * MS_PER_TICK;

/**
 * GUARD 2 — backoff CAP. The exponential backoff delay is clamped to this maximum
 * so a long-rejected option still gets an occasional retry (and the
 * `backoffUntilSimMs` arithmetic never overflows a sim-time window). ~30 sim-min.
 */
export const BACKOFF_CAP_SIM_MS = 30 * MS_PER_TICK;

/**
 * GUARD 2 — backoff JITTER span (sim-ms). The seeded jitter added to each backoff
 * delay is a draw in `[0, BACKOFF_JITTER_SIM_MS)` from the per-center coordinator
 * substream (`deriveCoordinatorRng`) — NEVER `Math.random`. The jitter decorrelates
 * the retry instants of two options that were rejected on the same pass so they do
 * not thunder back together. ~1 sim-min span, an integer number of sim-ms.
 */
export const BACKOFF_JITTER_SIM_MS = 1 * MS_PER_TICK;
