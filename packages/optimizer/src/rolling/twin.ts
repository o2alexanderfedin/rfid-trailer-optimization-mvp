import type { OptimizerScope } from "../graph/types.js";
import type { TwinSnapshot } from "./types.js";

/**
 * `@mm/optimizer` — `buildTwin`: the OPT-04 `structuredClone` planning sandbox.
 *
 * The optimizer evaluates candidate plans over a TWIN — a deep clone of the
 * affected slice of the projection snapshot. Because it is a `structuredClone`,
 * mutating the twin during evaluation can NEVER reach the source snapshot (and
 * thus never the real projection): evaluation has ZERO side effects until the
 * shell explicitly accepts a plan and appends the ONE `PlanAccepted` event.
 *
 * It also enforces the OPT-05 SCOPE: only trailers/hubs in `scope` survive, and
 * a route leg survives only if BOTH its endpoints are in scope — so the twin (and
 * the graph built from it) stays bounded to the affected slice (anti-P9).
 *
 * Pure + deterministic: no clock, no RNG; order-preserving filters, then one
 * `structuredClone` (so the result shares NO references with the source).
 */
export function buildTwin(
  scope: OptimizerScope,
  snapshot: TwinSnapshot,
): TwinSnapshot {
  const hubSet = new Set(scope.hubIds);
  const trailerSet = new Set(scope.trailerIds);

  const scoped: TwinSnapshot = {
    hubs: snapshot.hubs.filter((h) => hubSet.has(h)),
    routes: snapshot.routes.filter(
      (r) => hubSet.has(r.fromHubId) && hubSet.has(r.toHubId),
    ),
    trailers: snapshot.trailers.filter((t) => trailerSet.has(t.trailerId)),
  };

  // ONE deep clone — the sandbox shares no references with the source, so
  // evaluation mutations stay contained (OPT-04 zero-side-effect guarantee).
  return structuredClone(scoped);
}
