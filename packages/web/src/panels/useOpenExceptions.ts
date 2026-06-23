/**
 * useOpenExceptions (VIZ-10) — the live OPEN-exception set, filterable by entity.
 *
 * The Hub Detail panel shows each trailer's open alerts WITHOUT an extra fetch by
 * reusing the already-streamed ws exception channel:
 *  - `snapshot.exceptionsOpen` is the full open set on connect/resync (replace).
 *  - `tick.exceptionsNew` / `tick.exceptionsResolved` are per-tick deltas.
 *
 * The ws `ExceptionItem.entityId` carries ONLY the trailerId (per the grounding),
 * so `exceptionsForEntity(open, trailerId)` is the correct, cheapest filter for
 * trailer-scoped alerts. Hub-scoped alerts are NOT in this stream — they would
 * need the `/hubs/:id/detail` endpoint to carry them (out of scope here; the
 * panel covers trailer-scoped alerts, which is what the demo surfaces per row).
 *
 * Pure helpers (`applyOpenSnapshot` / `applyOpenDelta` / `exceptionsForEntity`)
 * are exported for Node unit tests, mirroring AlertFeed's helper discipline.
 */
import { useCallback, useRef, useState } from "react";
import { useWsEnvelope } from "../map/WsProvider.js";
import { makeEntityMaps } from "../map/wsClient.js";
import type { ExceptionItem, WsEnvelope } from "@mm/api";
import type { EntityMaps } from "../map/wsClient.js";

// ---------------------------------------------------------------------------
// Pure helpers (exported for Node unit tests)
// ---------------------------------------------------------------------------

/** Replace the open set from a snapshot's `exceptionsOpen` (resync semantics). */
export function applyOpenSnapshot(
  _current: readonly ExceptionItem[],
  open: readonly ExceptionItem[],
): ExceptionItem[] {
  // Dedup defensively by id (the server already dedups; cheap insurance).
  const byId = new Map<string, ExceptionItem>();
  for (const e of open) byId.set(e.id, e);
  return [...byId.values()];
}

/**
 * Apply a tick delta: add `newOnes` (dedup by id) and drop `resolvedIds`.
 * Returns a new array (immutable update for React state).
 */
export function applyOpenDelta(
  current: readonly ExceptionItem[],
  newOnes: readonly ExceptionItem[],
  resolvedIds: readonly string[],
): ExceptionItem[] {
  const byId = new Map<string, ExceptionItem>();
  for (const e of current) byId.set(e.id, e);
  for (const e of newOnes) byId.set(e.id, e);
  for (const id of resolvedIds) byId.delete(id);
  return [...byId.values()];
}

/** Filter the open set to the exceptions whose `entityId` matches (VIZ-10). */
export function exceptionsForEntity(
  open: readonly ExceptionItem[],
  entityId: string,
): ExceptionItem[] {
  return open.filter((e) => e.entityId === entityId);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** A stable lookup: given a trailerId, return its open exceptions (VIZ-10). */
export type OpenExceptionLookup = (entityId: string) => ExceptionItem[];

/**
 * Subscribe to the shared ws bus and maintain the live OPEN-exception set as
 * React state. Returns a lookup that filters by `entityId` (trailerId), so each
 * Hub Detail row can show its trailer's open alerts with NO extra fetch.
 */
export function useOpenExceptions(): OpenExceptionLookup {
  const [open, setOpen] = useState<readonly ExceptionItem[]>([]);
  const entityMapsRef = useRef<EntityMaps>(makeEntityMaps());

  const onEnvelope = useCallback((envelope: WsEnvelope): void => {
    if (envelope.type === "snapshot") {
      setOpen((cur) => applyOpenSnapshot(cur, envelope.payload.exceptionsOpen));
    } else {
      const { exceptionsNew, exceptionsResolved } = envelope.payload;
      if (exceptionsNew !== undefined || exceptionsResolved !== undefined) {
        setOpen((cur) =>
          applyOpenDelta(cur, exceptionsNew ?? [], exceptionsResolved ?? []),
        );
      }
    }
  }, []);

  useWsEnvelope(onEnvelope, entityMapsRef.current);

  return useCallback(
    (entityId: string) => exceptionsForEntity(open, entityId),
    [open],
  );
}
