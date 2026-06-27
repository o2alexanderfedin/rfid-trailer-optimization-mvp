/**
 * useSuggestions (VIZ-17) — Advisory Suggestions feed hook + pure helpers.
 *
 * Mirror of `useAlertFeed` (`AlertFeed.tsx`) for the suggestion overlay feed:
 *  - suggestions arrive via the ws tick TickPayload.suggestions (transient,
 *    NEVER on SnapshotPayload — Pitfall 7).
 *  - The feed is newest-first, deduped by suggestionId, capped at
 *    MAX_FEED_ENTRIES (T-27-16 DoS bound).
 *
 * The pure helpers (`applySuggestions`, `sortSuggestionFeed`,
 * `suggestionKindLabel`) are exported for Node unit tests (no DOM).
 */
import { useState, useCallback } from "react";
import type { SuggestionEvent } from "@mm/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One entry in the suggestion feed — SuggestionEvent enriched with a
 * server sim-clock timestamp so newest-first ordering works correctly.
 */
export interface SuggestionFeedEntry {
  readonly suggestionId: string;
  readonly kind: "reroute" | "hold" | "consolidate" | "dispatch";
  readonly outcome: "accepted" | "rejected";
  readonly entityId: string;
  readonly toHubId: string;
  /** Present only on rejected outcomes (closed reason code). */
  readonly reasonCode?: "hos" | "fuel" | "dock" | "infeasible";
  /** Sim-clock ms when this suggestion outcome was received (injected by applySuggestions). */
  readonly simMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of entries retained in the suggestion feed (T-27-16 bound).
 * When exceeded, the oldest entries (lowest simMs, stable by suggestionId) are
 * dropped until the cap is met — mirroring AlertFeed.MAX_FEED_ENTRIES.
 */
export const MAX_FEED_ENTRIES = 200;

// ---------------------------------------------------------------------------
// Pure state helpers (exported for Node unit tests)
// ---------------------------------------------------------------------------

/**
 * Append new suggestion outcomes to the feed.
 *
 * Each incoming `SuggestionEvent` is enriched with `simMs` (the caller
 * passes the tick's sim-clock value). Deduplication is by `suggestionId`:
 * if an entry already exists in the feed, the incoming event is skipped
 * (first-write wins — the server may re-emit the same id on resync, but
 * suggestions are transient and must never be re-flashed on reconnect).
 *
 * When the feed exceeds MAX_FEED_ENTRIES, the oldest entries (ascending
 * simMs; stable by suggestionId ascending as tie-break) are dropped.
 */
export function applySuggestions(
  current: readonly SuggestionFeedEntry[],
  incoming: readonly SuggestionEvent[],
  simMs: number,
): SuggestionFeedEntry[] {
  const existingIds = new Set(current.map((e) => e.suggestionId));
  const toAdd: SuggestionFeedEntry[] = incoming
    .filter((e) => !existingIds.has(e.suggestionId))
    .map((e): SuggestionFeedEntry => {
      const base = {
        suggestionId: e.suggestionId,
        kind: e.kind,
        outcome: e.outcome,
        entityId: e.entityId,
        toHubId: e.toHubId,
        simMs,
      };
      // exactOptionalPropertyTypes: omit reasonCode when absent rather than
      // setting it to undefined (which is a distinct assignability error).
      if (e.reasonCode !== undefined) {
        return { ...base, reasonCode: e.reasonCode };
      }
      return base;
    });

  let next: SuggestionFeedEntry[] = [...current, ...toAdd];

  if (next.length > MAX_FEED_ENTRIES) {
    // Sort ascending by simMs (oldest first), stable by suggestionId ascending.
    const sorted = [...next].sort((a, b) => {
      const diff = a.simMs - b.simMs;
      return diff !== 0 ? diff : a.suggestionId < b.suggestionId ? -1 : a.suggestionId > b.suggestionId ? 1 : 0;
    });
    next = sorted.slice(next.length - MAX_FEED_ENTRIES);
  }

  return next;
}

/**
 * Sort a copy of the suggestion feed newest-first (descending simMs).
 * Stable tie-break by suggestionId ascending (deterministic ordering).
 * Does NOT mutate the input array.
 */
export function sortSuggestionFeed(
  feed: readonly SuggestionFeedEntry[],
): SuggestionFeedEntry[] {
  return [...feed].sort((a, b) => {
    const diff = b.simMs - a.simMs;
    return diff !== 0 ? diff : a.suggestionId < b.suggestionId ? -1 : a.suggestionId > b.suggestionId ? 1 : 0;
  });
}

/**
 * Human-readable Title Case label for each suggestion kind.
 */
export function suggestionKindLabel(
  kind: SuggestionFeedEntry["kind"],
): string {
  switch (kind) {
    case "reroute":
      return "Reroute";
    case "hold":
      return "Hold";
    case "consolidate":
      return "Consolidate";
    case "dispatch":
      return "Dispatch";
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Return value of useSuggestions — the sorted feed + the dispatcher. */
export interface SuggestionsState {
  readonly feed: readonly SuggestionFeedEntry[];
  readonly onSuggestions: (
    events: readonly SuggestionEvent[],
    simMs: number,
  ) => void;
}

/**
 * React hook that maintains the sorted advisory-suggestion feed as normal
 * React state (NOT on the map ref-path). Wire `onSuggestions` to the ws
 * tick envelope handler — only dispatch on the TICK branch, NEVER on the
 * snapshot branch (Pitfall 7: transient field, must not re-flash on resync).
 */
export function useSuggestions(): SuggestionsState {
  const [entries, setEntries] = useState<readonly SuggestionFeedEntry[]>([]);

  const onSuggestions = useCallback(
    (events: readonly SuggestionEvent[], simMs: number) => {
      setEntries((prev) => applySuggestions(prev, events, simMs));
    },
    [],
  );

  return {
    feed: sortSuggestionFeed(entries),
    onSuggestions,
  };
}
