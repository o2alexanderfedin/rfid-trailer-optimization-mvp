import type { Rng } from "../rng.js";
import type { AgentKind } from "./agent.js";

/**
 * OODA-02 — the PURE hub Observe→Decide→Act function + its frozen observation and
 * closed decision union.
 *
 * `decideHub(obs, rng)` reads ONLY the FROZEN `obs` snapshot and draws any
 * stochastic tie-break ONLY from the passed per-agent substream `rng` (never
 * `Math.random`, never `Date.now()` — DET-03). It NEVER mutates `obs`. Identical
 * `(obs, rng-state)` ⇒ identical `HubDecision` (the determinism keystone).
 *
 * Structure mirrors the truck Decide (`./truck.ts`): a documented priority ladder
 * over the frozen observation, with the genuinely-new branch chosen first and a
 * no-op default last. The CONTEXT decision is that BOTH agent types run this phase
 * (P25 coordinators need both to arbitrate), so the hub Decide is a first-class
 * pure leaf here even though its richer wiring lands incrementally.
 *
 * PITFALLS Pitfall 2 (no transcendental geometry in decision payloads): every
 * decision-relevant numeric on `HubObservation` is an INTEGER (queue depths, dock
 * counts, fill/manifest counts) or a string id. Nothing float/geometry-derived
 * flows in (the engine rounds at the boundary BEFORE building the observation).
 *
 * PRIORITY LADDER (documented, deterministic):
 *
 *   1. DISPATCH — outbound freight is queued AND a trailer is filled enough to run
 *      AND a dock door is free. A loaded trailer with a free door should move
 *      freight outbound; this is the highest-value action.
 *   2. CONSOLIDATE — spoke-origin freight is staged for a spoke→center
 *      consolidation trailer (pending-consolidation manifest non-empty) and no
 *      dispatch fired. Drain the staged manifest onto the consolidation leg.
 *   3. HOLD — the no-op default: outbound queued but no free dock (wait), or simply
 *      nothing to do. ALWAYS feasible, so a hub tick always closes (the P25
 *      no-livelock foundation).
 */

/**
 * A FROZEN hub observation — the frame-N snapshot the hub Decide reads. All
 * decision-relevant fields are integer or string (Pitfall 2). No live references;
 * the engine builds this once per pass at pass entry (no mid-tick read-your-writes).
 */
export interface HubObservation {
  readonly kind: AgentKind;
  /** The observing hub's stable id (its substream key + dispatch identity). */
  readonly stableId: string;
  /** Current virtual tick (integer) — the frame this snapshot is taken at. */
  readonly tick: number;
  /** Which center this hub is assigned to / serves (P23 `centerOf`), or null. */
  readonly assignedCenterId: string | null;
  /** Inbound (to-be-unloaded) queue depth at this hub (count). */
  readonly inboundQueueDepth: number;
  /** Outbound (to-be-dispatched) queue depth at this hub (count). */
  readonly outboundQueueDepth: number;
  /** Number of dock doors currently free (integer >= 0). */
  readonly dockDoorsAvailable: number;
  /** How many packages are loaded on the trailer staged for the next dispatch. */
  readonly trailerFillCount: number;
  /** Size of the pending spoke→center consolidation manifest (count). */
  readonly pendingConsolidationCount: number;
}

/** Why a hub held (no dispatch/consolidate this pass) — the no-op closure. */
export type HubHoldReason = "dock-busy" | "nothing-to-do";

/**
 * The CLOSED hub decision union — the output of `decideHub`. Each variant maps to
 * the EXISTING centralized events the engine already emits for that decision
 * point (dispatch→`TrailerDeparted`, consolidate→consolidation `TrailerDeparted`),
 * just DECIDED locally; `hold` is a no-op (no event).
 */
export type HubDecision =
  | { readonly kind: "dispatch"; readonly trailerId: string }
  | { readonly kind: "hold"; readonly reason: HubHoldReason }
  | {
      readonly kind: "consolidate";
      readonly spokeHubId: string;
      readonly packageIds: readonly string[];
    };

/**
 * How filled a staged trailer must be before the hub will dispatch it. A
 * deterministic integer threshold over the frozen observation (no RNG): a trailer
 * with at least this many packages is "worth running" outbound.
 */
const DISPATCH_FILL_THRESHOLD = 1;

/**
 * The pure hub decision. See the priority ladder above. The `rng` is threaded for
 * a future stochastic tie-break (parity with `decideTruck`); the current ladder is
 * a deterministic function of the frozen observation, so the parameter keeps the
 * contract uniform without yet drawing.
 */
export function decideHub(obs: HubObservation, rng: Rng): HubDecision {
  // Parity with `decideTruck(obs, rng)`: the per-agent substream is threaded for a
  // future stochastic tie-break (e.g. choosing among equally-ready consolidation
  // spokes once the engine supplies a candidate set). The current ladder is a
  // deterministic function of the frozen observation, so we do NOT draw here —
  // `void rng` documents the intentional no-draw (an unused-but-contractual arg).
  void rng;

  // (1) DISPATCH — a filled trailer + a free dock + outbound demand: move freight.
  if (
    obs.outboundQueueDepth > 0 &&
    obs.trailerFillCount >= DISPATCH_FILL_THRESHOLD &&
    obs.dockDoorsAvailable > 0
  ) {
    // The dispatching trailer is identified by the hub's own stable id namespace
    // (the engine resolves the concrete staged trailer; the pure leaf names the
    // hub-scoped dispatch). A deterministic id keeps the decision replay-stable.
    return { kind: "dispatch", trailerId: `${obs.stableId}-OUT` };
  }

  // (2) CONSOLIDATE — staged spoke-origin freight awaiting a consolidation leg.
  if (obs.pendingConsolidationCount > 0) {
    return { kind: "consolidate", spokeHubId: obs.stableId, packageIds: [] };
  }

  // (3) HOLD — the no-op default. Distinguish a dock-bound wait (outbound demand
  // but every door busy) from a genuinely idle hub, so the reason is auditable.
  if (obs.outboundQueueDepth > 0 && obs.dockDoorsAvailable === 0) {
    return { kind: "hold", reason: "dock-busy" };
  }
  return { kind: "hold", reason: "nothing-to-do" };
}
