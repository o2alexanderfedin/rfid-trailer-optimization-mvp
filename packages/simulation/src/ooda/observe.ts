import type { AgentKind } from "./agent.js";

/**
 * OODA-04 — the FROZEN per-tick observation surface + the truck decision union.
 *
 * PITFALLS Pitfall 4 (frozen observation): an agent's Observe is a PURE READ at
 * pass entry. The `AgentObservation` is a readonly, plain-data SNAPSHOT of the
 * frame-N world state — no live references, no methods, no mutable fields. The
 * Decide consumes this value; it must NEVER read live engine state mid-pass
 * (which would create read-your-writes order dependence). The engine (24-02)
 * builds the snapshot ONCE per agent-pass, then hands it to `decideTruck`.
 *
 * PITFALLS Pitfall 2 (no transcendental geometry in decision payloads): every
 * decision-relevant numeric here is an INTEGER (miles, minutes, counts) or a
 * string id. Great-circle/float geometry is rounded at the engine boundary BEFORE
 * the observation is built, so nothing irrational flows into a hashed decision.
 */

/** An HOS clock snapshot (mirror of the domain `HosClock`, frozen + serializable). */
export interface ObservedHosClock {
  readonly driveTodayMin: number;
  readonly dutyWindowStartAt: string;
  readonly sinceLastBreakMin: number;
  readonly weeklyOnDutyMin: number;
  readonly comeOnDutyAt: string;
  readonly sleeperBerthLongMin: number;
  readonly sleeperBerthShortMin: number;
}

/**
 * A FROZEN truck observation — the frame-N snapshot the truck Decide reads. All
 * decision-relevant fields are integer or string (Pitfall 2); booleans flag
 * dock availability. No live references; the engine builds this once per pass.
 */
export interface AgentObservation {
  readonly kind: AgentKind;
  /** The observing agent's stable id (its substream key). */
  readonly stableId: string;
  /** Current virtual tick (integer) — the frame this snapshot is taken at. */
  readonly tick: number;
  /** The trip the truck is currently driving, or null between trips. */
  readonly tripId: string | null;
  /** Which center this truck is assigned to / heading toward (P23 `centerOf`). */
  readonly assignedCenterId: string | null;
  /** The in-flight leg key `"<from>-><to>"`, or null when not on a leg. */
  readonly currentLegKey: string | null;
  /** Per-trailer odometer miles since last refuel (rounded integer). */
  readonly odometerMiles: number;
  /** Minutes of legal driving remaining under HOS (rounded integer, >= 0). */
  readonly remainingLegalDriveMinutes: number;
  /** Minutes since the last >= 30-min break (rounded integer). */
  readonly minutesSinceLastBreak: number;
  /** The authoritative HOS clock snapshot (frozen). */
  readonly hosClock: ObservedHosClock;
  /** The next hub on the route, or null if the route is complete. */
  readonly nextHubId: string | null;
  /** Pending inbound queue depth at the next hub (count). */
  readonly nextHubQueueDepth: number;
  /** Whether a dock door is available at the next hub right now. */
  readonly nextHubDockAvailable: boolean;
}

/** Why a truck rested — mirrors `TruckRested.reason` (the HOS segment). */
export type RestReason = "rest-10h" | "break-30min";

/** Why a truck held in place (no movement, no event) this pass. */
export type HoldReason = "dock-unavailable" | "no-trip" | "awaiting-clearance";

/** Why a truck chose to divert (re-route) — the genuinely-new decision (TrailerDiverted). */
export type DivertReason = "next-hub-congested" | "next-hub-blocked" | "rebalance";

/**
 * The CLOSED truck decision union — the output of `decideTruck`. Each variant
 * maps to an existing emitted event (proceed→no-op, rest→TruckRested,
 * refuel→TruckRefueled, hold→no-op) EXCEPT `divert`, which maps to the new
 * `TrailerDiverted` event (the only decision with no current centralized analog).
 */
export type TruckDecision =
  | { readonly kind: "proceed" }
  | { readonly kind: "divert"; readonly toHubId: string; readonly reason: DivertReason }
  | { readonly kind: "rest"; readonly reason: RestReason; readonly durationMin: number }
  | {
      readonly kind: "refuel";
      readonly gallons: number;
      readonly odometerMiles: number;
      readonly durationMin: number;
    }
  | { readonly kind: "hold"; readonly reason: HoldReason };
