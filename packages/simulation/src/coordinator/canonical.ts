/**
 * Phase-25 COORD-02 / DET-03 / PITFALLS Pitfall 7 — CANONICALIZE the
 * `ActionSuggested` hashed payload.
 *
 * The determinism goldens hash the emitted event stream via `JSON.stringify`,
 * which is key-ORDER sensitive: the SAME values serialized in two different key
 * orders produce DIFFERENT bytes (the continuation-equivalence keystone already
 * learned this for the HOS clock — see `canonicalHosClock` in engine.ts — and
 * again for `TrailerDiverted` via `canonicalizeOodaPayload` in ooda/canonical.ts).
 *
 * The advisory coordinators (Plan 02) introduce ONE genuinely-new hashed payload
 * with a rich, multi-field shape — `ActionSuggested` — constructed in the in-fold
 * `stepCoordinators` task from coordinator-decided fields. To guarantee that
 * payload is byte-stable regardless of how the object literal happens to be built
 * (or refactored later), every `ActionSuggested` payload is routed through THIS
 * one canonicalizer (mirroring the repo's `canonicalize`/`canonicalHosClock`/
 * `canonicalizeOodaPayload` discipline: a single fixed-key-order site, values
 * untouched, key order pinned).
 *
 * `SuggestionAccepted` / `SuggestionRejected` carry only ids + a closed
 * `reasonCode` enum + `occurredAt`; a single canonicalizer for the
 * `ActionSuggested` params object is sufficient this phase. If Plan 03 finds the
 * reject payload also needs pinning, extend here.
 *
 * This is a PURE function — no wall-clock, no RNG, no async (DET-03). The ESLint
 * static guard scoped to `coordinator/**` (added with the coordinator wiring in
 * Plan 05, mirroring the existing `ooda/**` guard) enforces that purity at lint
 * time.
 */

import type { ActionSuggested } from "@mm/domain";

/** The canonical, fixed field order for an `ActionSuggested` payload. */
export function canonicalizeSuggestionPayload(
  payload: ActionSuggested["payload"],
): ActionSuggested["payload"] {
  // Fixed key order (matches the zod schema declaration order in
  // packages/domain/src/events/schemas.ts), values untouched — only the key order
  // is pinned, so two builds / two code paths serialize byte-identically. The
  // nested `params` is re-spread (NOT shared by reference) so its own field order
  // is likewise normalized to its declaration order.
  return {
    suggestionId: payload.suggestionId,
    coordinatorId: payload.coordinatorId,
    targetAgentId: payload.targetAgentId,
    kind: payload.kind,
    params: { ...payload.params },
    issuedAtSimMs: payload.issuedAtSimMs,
    ttlSimMs: payload.ttlSimMs,
  };
}
