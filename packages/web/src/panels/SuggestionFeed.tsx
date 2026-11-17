/**
 * SuggestionFeed (VIZ-17) — Advisory Suggestions feed component.
 *
 * Renders accepted (green) and rejected (red) coordination suggestion
 * outcomes, newest-first. Visually a sibling of AlertFeed — reuses the
 * `.alert-feed__*` CSS classes 1:1 for visual consistency.
 *
 * Security:
 *  - Threat T-27-15: all text via React default escaping; NO dangerouslySetInnerHTML.
 *  - Reject copy comes from the closed `COORDINATION_REJECT_LABELS` constant
 *    (not free text from the wire), so XSS via server-sourced strings is
 *    structurally prevented.
 *
 * Data flow: drive via `useSuggestions` from `App.tsx` (ws tick-only, Pitfall 7).
 */
import { COORDINATION_REJECT_LABELS } from "@mm/projections";
import { suggestionKindLabel } from "./useSuggestions.js";
import type { SuggestionFeedEntry } from "./useSuggestions.js";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SuggestionFeedProps {
  /** The sorted suggestion feed (drive via useSuggestions). */
  readonly feed: readonly SuggestionFeedEntry[];
}

/**
 * SuggestionFeed renders the operator's realtime advisory-suggestion feed
 * (VIZ-17).
 *
 * Design (frontend-design skill):
 *  - Accept rows: green accent (#4ade80) glyph ✓ + "Accepted — Kind Entity → Hub"
 *  - Reject rows: red accent (#f87171) + verbatim COORDINATION_REJECT_LABELS copy
 *  - Clear empty state when no suggestions are active.
 *  - Newest entries at the top (caller must pass a sorted feed from useSuggestions).
 *  - No dangerouslySetInnerHTML — all text via React's default escaping (T-27-15).
 */
export function SuggestionFeed({ feed }: SuggestionFeedProps): React.JSX.Element {
  if (feed.length === 0) {
    return (
      <div className="alert-feed" data-testid="suggestion-feed">
        <div className="alert-feed__empty" data-testid="suggestion-feed-empty">
          No active suggestions
        </div>
      </div>
    );
  }

  return (
    <div className="alert-feed" data-testid="suggestion-feed">
      {feed.map((entry) => {
        const isAccepted = entry.outcome === "accepted";
        // Reject copy: verbatim from COORDINATION_REJECT_LABELS (closed constant).
        // Accepted copy: "Accepted — {Kind} {entityId} → {toHubId}".
        const rejectLabel =
          entry.reasonCode !== undefined
            ? COORDINATION_REJECT_LABELS[entry.reasonCode]
            : "declined";

        return (
          <div
            key={entry.suggestionId}
            className={`alert-feed__entry ${
              isAccepted ? "alert-feed__entry--low" : "alert-feed__entry--high"
            }`}
            data-testid="suggestion-feed-entry"
            data-outcome={entry.outcome}
            data-kind={entry.kind}
          >
            <div className="alert-feed__entry-header">
              <span
                className="alert-feed__kind"
                style={{ color: isAccepted ? "#4ade80" : "#f87171" }}
              >
                {isAccepted ? "✓" : "✕"} {suggestionKindLabel(entry.kind)}
              </span>
              <span
                className="alert-feed__severity"
                style={{ color: isAccepted ? "#4ade80" : "#f87171" }}
              >
                {isAccepted ? "ACCEPTED" : "REJECTED"}
              </span>
            </div>
            <div className="alert-feed__entity">{entry.entityId}</div>
            {isAccepted ? (
              <div className="alert-feed__reason">
                {entry.entityId} {entry.toHubId !== "" ? `→ ${entry.toHubId}` : ""}
              </div>
            ) : (
              <div className="alert-feed__reason">{rejectLabel}</div>
            )}
            {!isAccepted && entry.toHubId !== "" && (
              <div className="alert-feed__action">
                Target: {entry.toHubId}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
