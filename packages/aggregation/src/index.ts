/**
 * `@mm/aggregation` (AGG-01..04) — a PURE, IO-free package that turns raw
 * `PlanningPackage[]` into feasible, prioritized `LoadBlock[]`.
 *
 * It imports ONLY `@mm/domain` (+ Node stdlib): no DB, no clock (`Date.now()`),
 * no RNG (`Math.random()`). Every function is deterministic — same input ⇒ same
 * output — so the planning pipeline replays identically (PITFALLS P3).
 *
 *  - {@link aggregate}      group → sum → prioritize → split (the entry point)
 *  - {@link splitBlock}     AGG-03 volume / handling-incompatibility split
 *  - {@link blockPriority}  AGG-04 lexicographic priority (SLA desc, deadline asc)
 *  - {@link deadlineBucket} deterministic coarse deadline bucket (no wall clock)
 */
export { aggregate } from "./aggregate.js";
export { splitBlock } from "./split.js";
export { blockPriority, type PrioritizableBlock } from "./priority.js";
export { deadlineBucket } from "./deadline-bucket.js";
