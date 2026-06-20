import { createHash } from "node:crypto";

import type { OptimizerScope } from "../graph/types.js";
import type { Epoch, TwinSnapshot } from "./types.js";

/**
 * `@mm/optimizer` — the OPT-06 anti-thrash KEYSTONE primitives: a canonical
 * `scopeHash` (the `(epoch, scope)` idempotency key) + the `isFrozen`
 * freeze-window predicate.
 *
 * Both are pure + deterministic (no clock, no RNG). The hash is canonical
 * (key-order-independent) so logically-identical inputs ALWAYS hash identically:
 * the rolling shell memoizes `EpochResult` by `${epochId}:${scopeHash}`, and the
 * freeze window protects near-departure trailers from re-planning — together the
 * two break the plan-thrash loop (PITFALLS P7).
 */

/**
 * Canonical JSON: stringify with object keys RECURSIVELY sorted, so the same
 * logical value serializes byte-identically regardless of key insertion order.
 * Arrays keep their order (order is meaningful in scope/snapshot). Numbers are
 * emitted as-is — the upstream graph/twin keep costs/volumes integral (anti-P12),
 * so there is no float-formatting ambiguity.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = canonicalize(obj[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * A stable hex digest of `(scope, twinSnapshot)` — the idempotency key. Canonical
 * serialization + sha256: structurally-identical inputs ⇒ identical hash; any
 * change to the scoped input ⇒ a different hash. No clock / RNG, so the same
 * epoch input always yields the same key (the OPT-06 memoization anchor).
 */
export function scopeHash(scope: OptimizerScope, twinSnapshot: TwinSnapshot): string {
  const canonical = JSON.stringify(canonicalize({ scope, twinSnapshot }));
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Is a trailer FROZEN this epoch? True when its scheduled departure falls within
 * the freeze window `[nowMin, nowMin + freezeWindowMin]` (inclusive) — a
 * near-departure trailer the optimizer must NOT touch (anti-P7: re-planning a
 * trailer about to leave just churns the plan). A trailer that already departed
 * (`departureMin < nowMin`) or departs beyond the window is NOT frozen.
 *
 * The clock comes from `epoch.nowMin` (sim/event time) — NEVER `Date.now()`.
 */
export function isFrozen(trailerDepartureMin: number, epoch: Epoch): boolean {
  const windowEnd = epoch.nowMin + epoch.freezeWindowMin;
  return trailerDepartureMin >= epoch.nowMin && trailerDepartureMin <= windowEnd;
}
