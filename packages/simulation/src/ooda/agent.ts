/**
 * OODA-04 — the agent base contract + the order-independence iteration
 * primitive.
 *
 * Determinism keystone (CONTEXT specifics): agents are processed per tick in a
 * DETERMINISTIC order derived ONLY from their STABLE id string — never Map/Set
 * insertion order, never array position, never spawn index. `sortAgentsByStableId`
 * is that single ordering rule; the shuffle-then-sort test is the strongest
 * determinism witness in the phase.
 */

/** The closed set of agent kinds this phase models (truck this plan, hub in 24-02/03). */
export type AgentKind = "truck" | "hub";

/**
 * The base agent contract. Every agent carries a `readonly stableId` (the sole
 * entropy source for its seeded substream, see `ooda/rng.ts`) and its `kind`.
 * Concrete agent state (per-type fields) is layered on by 24-02/03; this plan
 * defines only the shared, order-relevant surface.
 */
export interface Agent {
  readonly kind: AgentKind;
  readonly stableId: string;
}

/**
 * Return a NEW array of `agents` sorted ASCENDING by `stableId`, using a pure,
 * locale-INDEPENDENT codepoint compare (mirrors `partitionChecksum`'s sort).
 *
 * Order-independence (OODA-04): a SHUFFLED input yields a byte-identical sorted
 * output — so whichever Map/Set/array the engine collects pending agents into,
 * the per-tick processing order is a deterministic function of the stable ids
 * alone. The input array is never mutated (a copy is sorted), so callers can
 * pass a live collection safely.
 *
 * Note: `<`/`>` on strings is a stable, locale-free codepoint comparison (NOT
 * `localeCompare`, which is locale-dependent and would drift across platforms).
 * Distinct stable ids never compare equal, so the sort is total and stable.
 */
export function sortAgentsByStableId<T extends { readonly stableId: string }>(
  agents: readonly T[],
): T[] {
  return [...agents].sort((a, b) =>
    a.stableId < b.stableId ? -1 : a.stableId > b.stableId ? 1 : 0,
  );
}
