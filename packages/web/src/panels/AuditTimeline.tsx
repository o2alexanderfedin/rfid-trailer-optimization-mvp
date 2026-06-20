/**
 * AuditTimeline (UI-02) — Read-only audit timeline for a package OR trailer.
 *
 * Fetches `GET /api/trailers/:id/history` or `GET /api/packages/:id/history`
 * and renders an ordered timeline of domain events, including the captured
 * system recommendation at plan-lifecycle entries.
 *
 * Design (frontend-design skill):
 *  - Timeline ordered oldest→newest (globalSeq ascending).
 *  - Decision entries with a `recommendation` field are visually highlighted.
 *  - Read-only: no mutations, no event writes (T-05-08).
 *  - Empty state is shown for unknown entity ids (empty history ≠ error).
 *
 * Threat T-05-16: all recommendation/eventType text rendered via React default escaping.
 *
 * Pure logic helpers exported for Node unit tests.
 */
import { useState, useEffect } from "react";
import {
  fetchTrailerHistory,
  fetchPackageHistory,
  type TrailerHistoryEntryDto,
} from "../api/client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Formatted entry ready for rendering. */
export interface FormattedTimelineEntry {
  readonly globalSeq: string;
  readonly label: string;
  readonly occurredAt: string;
  readonly hubId: string | null;
  readonly recommendation: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for Node unit tests)
// ---------------------------------------------------------------------------

/**
 * Sort timeline entries by globalSeq ascending (oldest first).
 * Uses numeric comparison so "10" > "9" (not lexicographic "9" > "10").
 * Does NOT mutate the input array.
 */
export function sortTimeline(
  entries: readonly TrailerHistoryEntryDto[],
): TrailerHistoryEntryDto[] {
  return [...entries].sort(
    (a, b) => Number(a.globalSeq) - Number(b.globalSeq),
  );
}

/**
 * Format a timeline entry for display, deriving a human-readable label
 * from the eventType and other fields.
 */
export function formatTimelineEntry(
  entry: TrailerHistoryEntryDto,
): FormattedTimelineEntry {
  // Build a label that includes the eventType — keeping it readable but
  // preserving the technical name for auditability.
  let label = entry.eventType;
  if (entry.hubId !== null) {
    label = `${entry.eventType} @ ${entry.hubId}`;
  }

  return {
    globalSeq: entry.globalSeq,
    label,
    occurredAt: entry.occurredAt,
    hubId: entry.hubId,
    recommendation: entry.recommendation,
  };
}

/**
 * Returns true iff the entry has a non-empty recommendation string.
 * Use this to visually highlight decision events in the timeline.
 */
export function hasRecommendation(entry: TrailerHistoryEntryDto): boolean {
  return typeof entry.recommendation === "string" && entry.recommendation.length > 0;
}

// ---------------------------------------------------------------------------
// Hook: useAuditTimeline
// ---------------------------------------------------------------------------

/** The entity type being inspected. */
export type EntityKind = "trailer" | "package";

interface TimelineFetchState {
  readonly entries: readonly TrailerHistoryEntryDto[];
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * Fetch the audit timeline for a trailer or package.
 * Returns empty entries when entityId is null.
 */
export function useAuditTimeline(
  kind: EntityKind,
  entityId: string | null,
): TimelineFetchState {
  const [state, setState] = useState<TimelineFetchState>({
    entries: [],
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (entityId === null) {
      setState({ entries: [], loading: false, error: null });
      return;
    }

    const controller = new AbortController();
    setState({ entries: [], loading: true, error: null });

    const fetcher =
      kind === "trailer"
        ? fetchTrailerHistory(entityId, controller.signal)
        : fetchPackageHistory(entityId, controller.signal);

    void fetcher
      .then((entries) => {
        if (!controller.signal.aborted) {
          setState({ entries, loading: false, error: null });
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          const msg =
            err instanceof Error ? err.message : "Failed to load history";
          setState({ entries: [], loading: false, error: msg });
        }
      });

    return () => {
      controller.abort();
    };
  }, [kind, entityId]);

  return state;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface AuditTimelineProps {
  /** "trailer" or "package" — determines which history endpoint is fetched. */
  readonly kind: EntityKind;
  /** The entity id to load the timeline for, or null for no selection. */
  readonly entityId: string | null;
}

/**
 * AuditTimeline renders an ordered event history for a trailer or package.
 *
 * Entries with a captured system recommendation are visually highlighted
 * (the `--has-recommendation` modifier class) so operators can easily
 * see where the optimizer made a decision and why.
 */
export function AuditTimeline({ kind, entityId }: AuditTimelineProps): React.JSX.Element {
  const { entries, loading, error } = useAuditTimeline(kind, entityId);

  if (entityId === null) {
    return (
      <div className="audit-timeline" data-testid="audit-timeline">
        <div className="audit-timeline__prompt">
          Select a trailer or package to view its history.
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="audit-timeline" data-testid="audit-timeline">
        <div className="audit-timeline__loading">
          Loading history for {kind} {entityId}…
        </div>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="audit-timeline" data-testid="audit-timeline">
        <div className="audit-timeline__error">Error: {error}</div>
      </div>
    );
  }

  const sorted = sortTimeline(entries);

  if (sorted.length === 0) {
    return (
      <div className="audit-timeline" data-testid="audit-timeline">
        <div className="audit-timeline__empty">
          No history found for {kind} {entityId}.
        </div>
      </div>
    );
  }

  return (
    <div className="audit-timeline" data-testid="audit-timeline">
      <div className="audit-timeline__header">
        {kind === "trailer" ? "Trailer" : "Package"}: {entityId}
      </div>
      <ol className="audit-timeline__list">
        {sorted.map((entry) => {
          const formatted = formatTimelineEntry(entry);
          const withRec = hasRecommendation(entry);
          return (
            <li
              key={entry.globalSeq}
              className={`audit-timeline__entry${withRec ? " audit-timeline__entry--has-recommendation" : ""}`}
              data-testid="audit-timeline-entry"
              data-seq={entry.globalSeq}
            >
              <div className="audit-timeline__entry-header">
                <span className="audit-timeline__label">{formatted.label}</span>
                <time
                  className="audit-timeline__time"
                  dateTime={formatted.occurredAt}
                >
                  {formatted.occurredAt}
                </time>
              </div>
              {withRec && (
                <div
                  className="audit-timeline__recommendation"
                  data-testid="audit-timeline-recommendation"
                >
                  <span className="audit-timeline__rec-label">Recommendation: </span>
                  {entry.recommendation}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
