/**
 * `@mm/optimizer` — the min-cost-flow (SSP) CONTRACT (OPT-02).
 *
 * The strong-typed boundary the Successive-Shortest-Path solver presents to the
 * rest of the optimizer (freight assignment, the objective, the repair loop) and
 * to the glpk.js exact-LP correctness ORACLE. Defining these shapes here — small,
 * readonly, integer-valued — keeps the solver a pure, deterministic function of
 * `(graph, supplies)` (anti-P3) with no clock and no RNG.
 *
 * Integer discipline (anti-P12): every `amount` is a non-negative-or-negative
 * INTEGER node supply/demand, and the solver operates only on the integer
 * `cost` / `capacity` of the {@link TimeExpandedGraph} edges, so the SSP optimum
 * and the glpk.js LP optimum agree to the last unit (no float drift).
 */

/**
 * A per-node supply (`amount > 0`, a source) or demand (`amount < 0`, a sink) of
 * flow. The `Σ amount` over all supplies MUST be zero (conservation): the total
 * units pushed out of sources equals the total pulled into sinks. `nodeId` is a
 * {@link FlowNode.id} of the graph the supplies are applied to.
 */
export interface Supply {
  /** A {@link FlowNode.id} in the graph. */
  readonly nodeId: string;
  /** Integer units: `> 0` source, `< 0` sink. The sum over all supplies is 0. */
  readonly amount: number;
}

/**
 * The result of a min-cost-flow solve.
 *
 *  - `feasible` — `true` iff the full requested supply could be routed to the
 *    sinks under edge capacity (a saturating cut ⇒ `false`). Feasibility is a
 *    SEPARATE output, never folded into the cost (anti-P2).
 *  - `totalCost` — `Σ edge.cost · flow(edge)` over the original graph edges, an
 *    INTEGER (0 when infeasible — no meaningful optimum). This is what the
 *    glpk.js oracle is asserted equal to.
 *  - `flowByEdgeId` — the optimal integer flow on every original graph edge
 *    (absent ⇒ 0). Deterministic for a given `(graph, supplies)`.
 */
export interface FlowResult {
  readonly totalCost: number;
  readonly flowByEdgeId: ReadonlyMap<string, number>;
  readonly feasible: boolean;
}
