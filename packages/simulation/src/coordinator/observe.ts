/**
 * Phase-25 COORD-01 — the FROZEN per-CENTER coordinator observation surface.
 *
 * PITFALLS Pitfall 4 (frozen observation): a coordinator's Observe is a PURE READ
 * at pass entry. The `CoordinatorObservation` is a readonly, plain-data SNAPSHOT
 * of the frame-N world state for ONE center's bounded scope — no live references,
 * no methods, no mutable fields. The rule-based Decide consumes this value; it
 * must NEVER read live engine state mid-pass (which would couple a suggestion to
 * iteration order — the order-shuffle witness). The engine (Plan 02 Task 3) builds
 * the snapshot ONCE per center at pass entry, then hands it to
 * `decideCoordinatorSuggestions`.
 *
 * PITFALLS Pitfall 1/2 (no float geometry / no RNG in decision payloads): every
 * decision-relevant numeric here is an INTEGER (queue depths, manifest counts,
 * sim-time milliseconds) or a string id. No lon/lat float geometry, no RNG value
 * flows into a hashed suggestion — the engine rounds any geometry-derived value at
 * THIS boundary before the observation is built.
 *
 * BOUNDED SCOPE (COORD-01 scaling thesis): a center's observation names ONLY its
 * OWN spokes (the spokes whose `centerOf === this center`) — never another
 * center's hubs/trailers. One coordinator's pass therefore costs
 * O(active-in-region), not O(total), and two centers can never conflict over the
 * same hub.
 */

/**
 * A FROZEN per-spoke snapshot inside one center's bounded scope. All fields are
 * integers/strings (Pitfall 2) read once from the engine fold maps.
 */
export interface ObservedSpoke {
  /** The spoke hub id (the suggestion target / param value). */
  readonly hubId: string;
  /** Pending INBOUND (center→spoke distribution) queue depth (count). */
  readonly inboundQueueDepth: number;
  /** Pending spoke→center CONSOLIDATION manifest size (count). */
  readonly pendingConsolidationCount: number;
  /** Whether a dock door is free at this spoke right now (the dock-busy proxy). */
  readonly dockAvailable: boolean;
}

/**
 * A FROZEN per-truck snapshot for a truck whose owning center is THIS center. The
 * coordinator advises a truck's reroute based on its next hub's congestion; it
 * does NOT check feasibility (the agent owns that — 24-03).
 */
export interface ObservedTruck {
  /** The trailer id (the reroute suggestion target). */
  readonly trailerId: string;
  /** The next hub on the truck's current trip, or null between trips. */
  readonly nextHubId: string | null;
  /** Inbound queue depth at the truck's next hub (count; 0 when no next hub). */
  readonly nextHubQueueDepth: number;
}

/**
 * The FROZEN observation for ONE regional center — the frame-N snapshot the
 * coordinator's rule-based Decide reads. Built once per center at pass entry from
 * the engine fold maps; integer/string only; bounded to this center's own scope.
 */
export interface CoordinatorObservation {
  /** This center's stable id (the coordinatorId + the substream key). */
  readonly centerId: string;
  /** Current virtual tick (integer) — the frame this snapshot is taken at. */
  readonly tick: number;
  /** Sim-time milliseconds since epoch at this frame (non-negative integer). */
  readonly issuedAtSimMs: number;
  /** This center's OWN spokes (bounded scope), in sorted-by-hubId order. */
  readonly spokes: readonly ObservedSpoke[];
  /** The in-region trucks (owned by this center), in sorted-by-trailerId order. */
  readonly trucks: readonly ObservedTruck[];
}
