import type { Rng } from "../rng.js";
import type { CoordinatorObservation } from "./observe.js";

/**
 * Phase-25 COORD-01/COORD-02 — the PURE, rule-based suggestion generator.
 *
 * `decideCoordinatorSuggestions(obs, rng)` is the micro-advisory generation
 * engine: over ONE center's FROZEN bounded observation it emits zero or more
 * advisory suggestions across the four closed kinds (reroute / hold / consolidate
 * / dispatch). It is RULE-BASED this phase (optimizer-backed generation is Phase
 * 26) with NAMED, tunable integer thresholds.
 *
 * DETERMINISM (the keystone): the function is PURE — a function of the frozen
 * observation + the seeded coordinator `rng` only (no `Date.now`, no
 * `Math.random`, no live engine read). Same frozen obs + same rng ⇒ byte-identical
 * suggestion list. Params are integer/string only (Pitfall 1): a suggestion
 * carries at most a `toHubId` (the reroute/dispatch destination); hold/consolidate
 * carry none. The `rng` parameter is the COORD-04 seeded-jitter substream
 * (consumed by the anti-oscillation guards in Plan 04); this phase generates the
 * raw rule-based suggestions deterministically over the observation.
 *
 * ADVISORY ONLY (the un-overridable contract from 24-03): the coordinator does
 * NOT check feasibility — it advises; the target agent alone accepts (→ a binding
 * event) or rejects (→ a reason code), wired in Plan 03. A no-suggestion center
 * returns `[]` (the feasible no-op default substrate for COORD-05 — no Zeno
 * livelock).
 */

/** Why a coordinator advised the suggestion (kept for the audit/rationale trail). */
export type CoordinatorSuggestionKind = "reroute" | "hold" | "consolidate" | "dispatch";

/**
 * A single advisory suggestion — the CLOSED union mapped 1:1 onto the
 * `ActionSuggested` payload `kind` + `targetAgentId` + `params`. `toHubId` is
 * present only for reroute/dispatch (a destination/origin hub); hold/consolidate
 * carry no param. All fields are integer/string (Pitfall 1).
 */
export type CoordinatorSuggestion =
  | { readonly kind: "reroute"; readonly targetAgentId: string; readonly toHubId: string }
  | { readonly kind: "hold"; readonly targetAgentId: string }
  | { readonly kind: "consolidate"; readonly targetAgentId: string }
  | { readonly kind: "dispatch"; readonly targetAgentId: string; readonly toHubId: string };

/**
 * NAMED rule thresholds (tunable, baked into the coordinator-on golden in Plan
 * 05). Following the OPT-06 / OODA observe.ts congestion proxies: a queue beyond a
 * congestion threshold is "congested"; a consolidation manifest beyond a fill
 * threshold is "ready to consolidate"; an outbound-ready manifest + a free dock is
 * "ready to dispatch".
 */
export const COORDINATOR_THRESHOLDS = {
  /** A next-hub inbound queue STRICTLY above this is "congested" ⇒ advise reroute. */
  congestionQueueDepth: 12,
  /** A spoke's pending-consolidation manifest STRICTLY above this ⇒ advise consolidate. */
  consolidationFill: 6,
  /** A spoke's pending-consolidation manifest STRICTLY above this + free dock ⇒ advise dispatch. */
  dispatchReadyFill: 3,
} as const;

/**
 * Generate the advisory suggestions for ONE center over its frozen observation.
 * PURE + deterministic (Pitfall 4): reads ONLY `obs` (+ the seeded `rng` for the
 * Plan-04 jitter substream). The suggestion order is a pure function of the
 * observation's already-sorted spokes/trucks, so it is byte-stable.
 */
export function decideCoordinatorSuggestions(
  obs: CoordinatorObservation,
  rng: Rng,
): readonly CoordinatorSuggestion[] {
  // `rng` is the per-center seeded substream reserved for the COORD-04 anti-
  // oscillation jitter/backoff (Plan 04). This phase generates the raw rule-based
  // suggestions deterministically over the FROZEN observation; referencing the
  // parameter here keeps the lazy-substream contract explicit without drawing
  // (a draw now would move the Plan-05 coordinator-on golden).
  void rng;

  const suggestions: CoordinatorSuggestion[] = [];

  // RULE 1 — REROUTE: an in-region truck whose NEXT hub's inbound queue exceeds
  // the congestion threshold AND an alternate (this center) exists ⇒ advise it to
  // reroute to its center for cross-dock relief. Iterate trucks in their already-
  // sorted-by-trailerId order (byte-stable). The alternate is the center hub
  // itself (always a valid cross-dock destination, never the congested next hub).
  for (const truck of obs.trucks) {
    if (
      truck.nextHubId !== null &&
      truck.nextHubId !== obs.centerId &&
      truck.nextHubQueueDepth > COORDINATOR_THRESHOLDS.congestionQueueDepth
    ) {
      suggestions.push({
        kind: "reroute",
        targetAgentId: truck.trailerId,
        toHubId: obs.centerId,
      });
    }
  }

  // RULES 2-4 over this center's spokes (already sorted by hubId — byte-stable).
  for (const spoke of obs.spokes) {
    // RULE 2 — HOLD: the spoke's dock is busy (a downstream target's next hub is
    // dock-busy) AND it has inbound freight waiting ⇒ advise it to hold rather
    // than push more onto a blocked dock.
    if (!spoke.dockAvailable && spoke.inboundQueueDepth > 0) {
      suggestions.push({ kind: "hold", targetAgentId: spoke.hubId });
    }

    // RULE 3 — CONSOLIDATE: the spoke's pending-consolidation manifest exceeds the
    // fill threshold ⇒ advise it to consolidate the staged freight onto a trailer.
    if (spoke.pendingConsolidationCount > COORDINATOR_THRESHOLDS.consolidationFill) {
      suggestions.push({ kind: "consolidate", targetAgentId: spoke.hubId });
    } else if (
      // RULE 4 — DISPATCH: a smaller-but-ready outbound manifest AND a free dock ⇒
      // advise it to dispatch the staged trailer toward its center now (else the
      // freight would idle). Mutually exclusive with consolidate (consolidate wins
      // on a fuller manifest) so the two rules never double-fire on one spoke.
      spoke.dockAvailable &&
      spoke.pendingConsolidationCount > COORDINATOR_THRESHOLDS.dispatchReadyFill
    ) {
      suggestions.push({
        kind: "dispatch",
        targetAgentId: spoke.hubId,
        toHubId: obs.centerId,
      });
    }
  }

  return suggestions;
}
