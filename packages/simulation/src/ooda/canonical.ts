/**
 * Phase-24 DET-03 / PITFALLS Pitfall 7 — CANONICALIZE every hashed OODA payload.
 *
 * The determinism goldens hash the emitted event stream via `JSON.stringify`, which
 * is key-ORDER sensitive: the SAME values serialized in two different key orders
 * produce DIFFERENT bytes (the continuation-equivalence keystone already learned
 * this for the HOS clock — see `canonicalHosClock` in engine.ts). The OODA agents
 * introduce ONE genuinely-new payload with no centralized analog — `TrailerDiverted`
 * — constructed in the `stepAgents` Act from agent-decided fields. To guarantee that
 * payload is byte-stable regardless of how the object literal happens to be built
 * (or refactored later), every `TrailerDiverted` payload is routed through THIS one
 * canonicalizer (mirroring the repo's `canonicalize`/`canonicalHosClock` discipline:
 * a single fixed-key-order site, values untouched, key order pinned).
 *
 * This is a PURE function — no wall-clock, no RNG, no async (DET-03). The ESLint
 * static guard scoped to `ooda/**` enforces that purity at lint time.
 */

import type { TrailerDiverted } from "@mm/domain";

/** The canonical, fixed field order for a `TrailerDiverted` payload. */
export function canonicalizeOodaPayload(
  payload: TrailerDiverted["payload"],
): TrailerDiverted["payload"] {
  // Fixed key order (matches the zod schema declaration order in
  // packages/domain/src/events/schemas.ts), values untouched — only the key order
  // is pinned, so two builds / two code paths serialize byte-identically.
  return {
    trailerId: payload.trailerId,
    tripId: payload.tripId,
    fromHubId: payload.fromHubId,
    toHubId: payload.toHubId,
    reason: payload.reason,
    occurredAt: payload.occurredAt,
  };
}
