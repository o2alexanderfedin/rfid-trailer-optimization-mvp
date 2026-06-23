/**
 * Driver-duty hub-marker coloring (VIZ-11 / HUBQ-08).
 *
 * The v1.2 demo payoff: a hub's marker reads its DRIVER AVAILABILITY at a glance.
 * The ws `HubState` carries three small integer driver buckets (added Phase 14):
 *   - `driverCount`  — drivers currently assigned to trailers at the hub.
 *   - `onBreakCount` — of those, drivers in the 30-min `on_break` state.
 *   - `restingCount` — of those, drivers in the 10h/34h `resting` state.
 *
 * Classification (pure, integer-only — same zero-alloc discipline as coloring.ts):
 *   - no driver data (back-compat older server, or 0 drivers)         → `null`
 *     (the hub falls back to its volume coloring; nothing is fabricated).
 *   - all drivers driving/available (none on break or resting)        → bucket 0
 *   - some on break, but at least one still available                 → bucket 1
 *   - some resting, but at least one still available                  → bucket 2
 *   - ALL drivers out of service right now (resting + on break = all) → bucket 3
 *
 * `DUTY_COLORS` / `DUTY_BUCKET_LABELS` are the SINGLE source of truth for both the
 * hub StyleFunction (layers.ts/coloring.ts) and the Legend driver-duty section.
 */
import type { HubState } from "@mm/api";

/**
 * One hex color per duty bucket (index 0 = best / all available, 3 = all out).
 * Green→amber→orange→slate so an "all-resting" hub reads distinctly (slate) from
 * the green→red VOLUME ramp (so the two coloring modes never visually collide).
 */
export const DUTY_COLORS: readonly string[] = [
  "#22c55e", // bucket 0 — all drivers available (driving / on-duty)
  "#eab308", // bucket 1 — some on break, at least one still available
  "#f97316", // bucket 2 — some resting, at least one still available
  "#64748b", // bucket 3 — all drivers out of service (resting / on break)
];

/** Display labels for each duty bucket (same index as `DUTY_COLORS`). */
export const DUTY_BUCKET_LABELS: readonly string[] = [
  "All available",
  "Some on break",
  "Some resting",
  "All drivers out",
];

/** Read a HubState driver bucket as a non-negative integer (absent → 0). */
function bucket(value: number | undefined): number {
  return typeof value === "number" && value > 0 ? value : 0;
}

/**
 * Whether a hub carries usable driver data — at least one driver assigned to a
 * trailer at the hub. Used to decide whether duty coloring applies at all.
 */
export function hubHasDriverData(hub: HubState): boolean {
  return bucket(hub.driverCount) > 0;
}

/**
 * Classify a hub's driver-duty distribution into a `DUTY_COLORS` bucket index, or
 * `null` when the hub has no driver data (→ caller falls back to volume coloring).
 *
 * Pure: a function of the three integer buckets only.
 */
export function classifyDutyBucket(hub: HubState): number | null {
  const count = bucket(hub.driverCount);
  if (count === 0) return null;

  const onBreak = bucket(hub.onBreakCount);
  const resting = bucket(hub.restingCount);
  const out = Math.min(count, onBreak + resting);

  // All assigned drivers are out of service right now.
  if (out >= count) return 3;
  // At least one driver is available — grade by the worst out-of-service signal.
  if (resting > 0) return 2;
  if (onBreak > 0) return 1;
  return 0;
}
