import type {
  HubDockFeasibility,
  TruckLegFeasibility,
} from "../ooda/feasibility.js";
import type { CoordinatorSuggestion } from "./coordinator.js";

/**
 * Phase-25 COORD-02 (consume half) — the PURE accept/reject arbitration.
 *
 * `arbitrateSuggestion(suggestion, verdict)` is the un-overridable feasibility
 * contract (24-03) expressed as a single pure function: a coordinator's advisory
 * `ActionSuggested` is ACCEPTED only when the target agent's OWN binding local
 * feasibility verdict allows the corresponding action — otherwise it is REJECTED
 * with the binding feasibility-failure reason. The function NEVER recomputes
 * feasibility; it READS the verdict the agent already produced (DRY — the agent's
 * verdict is authoritative, a coordinator cannot force an infeasible action).
 *
 * PRIORITY (mirrors the 24-03 feasibility gate ladder): for a truck reroute the
 * binding ladder is HOS > fuel — `mustRest`/`!canDrive` (HOS) outranks `mustRefuel`
 * (fuel), so an HOS-out truck rejects with `"hos"` even when also out of fuel. A
 * hub consolidate/dispatch is gated solely on the dock verdict (`"dock"` when no
 * door is free). A `hold` is ALWAYS accepted: holding is the feasible no-op default
 * (the COORD-05 substrate / anti-livelock — an agent can always close its tick by
 * holding), so it never rejects regardless of the verdict.
 *
 * PURITY (DET-03): a total function of the suggestion + the frozen verdict only —
 * no wall clock, no RNG, no engine read. Identical inputs ⇒ identical output.
 */

/** The closed reject vocabulary — exactly the Plan-01 `SuggestionRejected.reasonCode` enum. */
export type SuggestionRejectReason = "hos" | "fuel" | "dock" | "infeasible";

/**
 * The closed binding-action kind an ACCEPTED suggestion maps to. `divert` ⇒ the
 * agent emits the existing `TrailerDiverted`; `consolidate`/`dispatch` ⇒ the agent
 * routes through the existing consolidation dispatch; `hold` ⇒ the agent emits
 * `SuggestionAccepted` but NO binding event (the feasible no-op); `none` is the hold
 * sentinel (kept distinct from a kind that emits a binding event).
 */
export type SuggestionBindingKind =
  | "divert"
  | "hold"
  | "consolidate"
  | "dispatch"
  | "none";

/**
 * The CLOSED arbitration result. On accept it names the binding kind the agent must
 * Act on; on reject it names the binding feasibility-failure reasonCode.
 */
export type SuggestionArbitration =
  | { readonly accepted: true; readonly bindingKind: SuggestionBindingKind }
  | { readonly accepted: false; readonly reasonCode: SuggestionRejectReason };

/** Type guard: a truck-leg verdict (vs a hub-dock verdict) by its shape. */
function isTruckVerdict(
  verdict: TruckLegFeasibility | HubDockFeasibility,
): verdict is TruckLegFeasibility {
  return "canDrive" in verdict;
}

/**
 * Arbitrate ONE advisory suggestion against the target agent's binding local
 * feasibility verdict. Pure + deterministic; the reject reasonCode is exactly the
 * closed `hos | fuel | dock | infeasible` enum.
 *
 * @param suggestion The coordinator's advisory suggestion (the closed 4-kind union).
 * @param verdict    The agent's OWN binding feasibility verdict (24-03) — a truck-leg
 *                   verdict for reroute, a hub-dock verdict for consolidate/dispatch.
 */
export function arbitrateSuggestion(
  suggestion: CoordinatorSuggestion,
  verdict: TruckLegFeasibility | HubDockFeasibility,
): SuggestionArbitration {
  switch (suggestion.kind) {
    case "hold":
      // The feasible no-op default — holding is always feasible (COORD-05). It emits
      // SuggestionAccepted but no binding event, so the bindingKind is `none`.
      return { accepted: true, bindingKind: "none" };

    case "reroute": {
      // A truck reroute (divert) is gated on the truck-leg verdict. The 24-03 ladder
      // is HOS > fuel: a truck that may not legally drive can never be diverted (no
      // amount of coordinator advice grants drive time), so HOS outranks fuel.
      if (!isTruckVerdict(verdict)) return { accepted: false, reasonCode: "infeasible" };
      if (verdict.mustRest || !verdict.canDrive) return { accepted: false, reasonCode: "hos" };
      if (verdict.mustRefuel) return { accepted: false, reasonCode: "fuel" };
      return { accepted: true, bindingKind: "divert" };
    }

    case "consolidate": {
      // A staged consolidation may only run when a dock door is free.
      if (isTruckVerdict(verdict)) return { accepted: false, reasonCode: "infeasible" };
      if (!verdict.canConsolidate) return { accepted: false, reasonCode: "dock" };
      return { accepted: true, bindingKind: "consolidate" };
    }

    case "dispatch": {
      // An outbound dispatch may only run when a dock door is free.
      if (isTruckVerdict(verdict)) return { accepted: false, reasonCode: "infeasible" };
      if (!verdict.canDispatch) return { accepted: false, reasonCode: "dock" };
      return { accepted: true, bindingKind: "dispatch" };
    }
  }
}
