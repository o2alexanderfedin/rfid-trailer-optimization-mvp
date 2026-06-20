/**
 * AlertFeed (UI-01) — Realtime exception feed.
 *
 * Renders every exception (wrong-trailer, missed-unload, blocked-freight,
 * low-utilization) with severity color coding, human-readable kind label,
 * the server's plain-English reason, and the recommended action.
 *
 * Data flow:
 *  - Exception deltas arrive via the ws tick envelope (`exceptionsNew` /
 *    `exceptionsResolved`).
 *  - The feed lives in normal React state (NOT the map's ref-path) so React
 *    manages re-renders cleanly without polluting the OL render loop.
 *  - Threat T-05-16: all text is rendered via React's default escaping —
 *    NO dangerouslySetInnerHTML.
 *  - Threat T-05-15: the feed is capped at MAX_FEED_ENTRIES; oldest entries
 *    are dropped when the cap is reached, preventing unbounded memory growth.
 *
 * The pure state helpers (`applyExceptionsNew`, `applyExceptionsResolved`,
 * `sortFeed`, `severityClass`, `kindLabel`) are exported for unit testing in
 * Node without a DOM, matching the project's existing test pattern.
 */
import { useState, useCallback } from "react";
import type { ExceptionItem } from "@mm/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single entry in the alert feed — same shape as ExceptionItem. */
export type FeedEntry = ExceptionItem;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of entries retained in the feed at once (T-05-15 bound).
 * When exceeded, the oldest entries (lowest simMs, stable by id) are dropped.
 */
export const MAX_FEED_ENTRIES = 200;

// ---------------------------------------------------------------------------
// Pure state helpers (exported for Node unit tests)
// ---------------------------------------------------------------------------

/**
 * Append new exceptions to the feed, deduplicating by id.
 * When the result exceeds MAX_FEED_ENTRIES, drop the oldest entries
 * (by simMs ascending, stable by id) until the cap is met.
 */
export function applyExceptionsNew(
  current: readonly FeedEntry[],
  incoming: readonly ExceptionItem[],
): FeedEntry[] {
  const existingIds = new Set(current.map((e) => e.id));
  const toAdd = incoming.filter((e) => !existingIds.has(e.id));
  let next: FeedEntry[] = [...current, ...toAdd];

  if (next.length > MAX_FEED_ENTRIES) {
    // Sort ascending by simMs (oldest first), drop from the start.
    const sorted = [...next].sort((a, b) => {
      const diff = a.simMs - b.simMs;
      return diff !== 0 ? diff : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    next = sorted.slice(next.length - MAX_FEED_ENTRIES);
  }

  return next;
}

/**
 * Remove entries whose ids are in `resolved` from the feed.
 * Entries not found are silently ignored.
 */
export function applyExceptionsResolved(
  current: readonly FeedEntry[],
  resolved: readonly string[],
): FeedEntry[] {
  const removedIds = new Set(resolved);
  return current.filter((e) => !removedIds.has(e.id));
}

/**
 * Sort a copy of the feed newest-first (descending simMs).
 * Stable tie-break by id ascending (deterministic ordering).
 * Does NOT mutate the input array.
 */
export function sortFeed(feed: readonly FeedEntry[]): FeedEntry[] {
  return [...feed].sort((a, b) => {
    const diff = b.simMs - a.simMs;
    return diff !== 0 ? diff : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * CSS class suffix for severity-coded styling.
 * Returns one of: "alert-feed__entry--low", "alert-feed__entry--med",
 * "alert-feed__entry--high".
 */
export function severityClass(severity: ExceptionItem["severity"]): string {
  return `alert-feed__entry--${severity}`;
}

/**
 * Human-readable label for each exception kind.
 */
export function kindLabel(kind: ExceptionItem["kind"]): string {
  switch (kind) {
    case "wrongTrailer":
      return "Wrong Trailer";
    case "missedUnload":
      return "Missed Unload";
    case "blockedFreight":
      return "Blocked Freight";
    case "lowUtilization":
      return "Low Utilization";
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Return value of useAlertFeed — the sorted feed + the delta handlers. */
export interface AlertFeedState {
  readonly feed: readonly FeedEntry[];
  readonly onExceptionsNew: (items: readonly ExceptionItem[]) => void;
  readonly onExceptionsResolved: (ids: readonly string[]) => void;
}

/**
 * React hook that maintains the sorted alert feed as normal React state.
 * Wire `onExceptionsNew` and `onExceptionsResolved` to the ws envelope
 * handler — they are stable references (wrapped in useCallback).
 */
export function useAlertFeed(): AlertFeedState {
  const [entries, setEntries] = useState<readonly FeedEntry[]>([]);

  const onExceptionsNew = useCallback((items: readonly ExceptionItem[]) => {
    setEntries((prev) => applyExceptionsNew(prev, items));
  }, []);

  const onExceptionsResolved = useCallback((ids: readonly string[]) => {
    setEntries((prev) => applyExceptionsResolved(prev, ids));
  }, []);

  return {
    feed: sortFeed(entries),
    onExceptionsNew,
    onExceptionsResolved,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface AlertFeedProps {
  /** The sorted exception feed (drive via useAlertFeed). */
  readonly feed: readonly FeedEntry[];
}

/**
 * AlertFeed renders the operator's realtime exception feed (UI-01).
 *
 * Design (frontend-design skill):
 *  - Severity color coding via CSS class suffix (low/med/high).
 *  - Clear empty state message when no exceptions are active.
 *  - Newest entries at the top (caller must pass a sorted feed).
 *  - No dangerouslySetInnerHTML — all text via React's default escaping.
 */
export function AlertFeed({ feed }: AlertFeedProps): React.JSX.Element {
  if (feed.length === 0) {
    return (
      <div className="alert-feed" data-testid="alert-feed">
        <div className="alert-feed__empty" data-testid="alert-feed-empty">
          No active exceptions
        </div>
      </div>
    );
  }

  return (
    <div className="alert-feed" data-testid="alert-feed">
      {feed.map((entry) => (
        <div
          key={entry.id}
          className={`alert-feed__entry ${severityClass(entry.severity)}`}
          data-testid="alert-feed-entry"
          data-severity={entry.severity}
          data-kind={entry.kind}
        >
          <div className="alert-feed__entry-header">
            <span className="alert-feed__kind">{kindLabel(entry.kind)}</span>
            <span
              className={`alert-feed__severity ${severityClass(entry.severity)}`}
            >
              {entry.severity.toUpperCase()}
            </span>
          </div>
          <div className="alert-feed__entity">{entry.entityId}</div>
          <div className="alert-feed__reason">{entry.reason}</div>
          <div className="alert-feed__action">{entry.recommendedAction}</div>
        </div>
      ))}
    </div>
  );
}
