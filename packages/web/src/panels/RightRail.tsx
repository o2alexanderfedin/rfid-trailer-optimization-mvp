/**
 * RightRail — operator panel sidebar composing AlertFeed + TrailerDetail.
 *
 * Layout (frontend-design skill):
 *  - Fixed-width right rail alongside the full-height map.
 *  - AlertFeed at the top, scrollable; TrailerDetail below.
 *  - A tab/toggle lets the operator switch between the plan-detail view and
 *    the audit timeline for the selected trailer.
 *  - Clean, legible operator aesthetic: neutral dark background, clear section
 *    headings, consistent padding, high-contrast text.
 *
 * The RightRail is a pure layout component — no data-fetching.
 * It composes:
 *  - AlertFeed: receives sorted exception feed props
 *  - TrailerDetail: receives the selected trailerId
 *  - AuditTimeline: rendered in a "History" tab for the selected trailer
 */
import { useState } from "react";
import { AlertFeed } from "./AlertFeed.js";
import { TrailerDetail } from "./TrailerDetail.js";
import { AuditTimeline } from "./AuditTimeline.js";
import type { FeedEntry } from "./AlertFeed.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DetailTab = "plan" | "history";

interface RightRailProps {
  /** The sorted realtime exception feed (from useAlertFeed). */
  readonly feed: readonly FeedEntry[];
  /** The currently selected trailer id (from map click), or null. */
  readonly selectedTrailerId: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Right-rail operator panel: alert feed + selected-trailer detail.
 *
 * The panel is split vertically:
 *  - Top: AlertFeed (scrollable exception list, most recent first)
 *  - Bottom: TrailerDetail / AuditTimeline (tabbed; shows plan or history)
 */
export function RightRail({
  feed,
  selectedTrailerId,
}: RightRailProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<DetailTab>("plan");

  return (
    <aside className="right-rail" data-testid="right-rail" aria-label="Operator panels">
      {/* --- Alert Feed (UI-01) ------------------------------------------- */}
      <section className="right-rail__section right-rail__section--feed">
        <header className="right-rail__section-header">
          <h2 className="right-rail__section-title">
            Live Exceptions
            {feed.length > 0 && (
              <span className="right-rail__badge" data-testid="exception-count">
                {feed.length}
              </span>
            )}
          </h2>
        </header>
        <div className="right-rail__feed-scroll">
          <AlertFeed feed={feed} />
        </div>
      </section>

      {/* --- Divider ------------------------------------------------------- */}
      <div className="right-rail__divider" role="separator" />

      {/* --- Trailer Detail / Audit Timeline (VIZ-05 + UI-02) -------------- */}
      <section className="right-rail__section right-rail__section--detail">
        <header className="right-rail__section-header">
          <h2 className="right-rail__section-title">
            {selectedTrailerId !== null
              ? `Trailer: ${selectedTrailerId}`
              : "Trailer Detail"}
          </h2>
          {selectedTrailerId !== null && (
            <div className="right-rail__tabs" role="tablist">
              <button
                className={`right-rail__tab${activeTab === "plan" ? " right-rail__tab--active" : ""}`}
                role="tab"
                aria-selected={activeTab === "plan"}
                onClick={() => setActiveTab("plan")}
              >
                Plan
              </button>
              <button
                className={`right-rail__tab${activeTab === "history" ? " right-rail__tab--active" : ""}`}
                role="tab"
                aria-selected={activeTab === "history"}
                onClick={() => setActiveTab("history")}
              >
                History
              </button>
            </div>
          )}
        </header>

        <div className="right-rail__detail-scroll">
          {activeTab === "plan" || selectedTrailerId === null ? (
            <TrailerDetail trailerId={selectedTrailerId} />
          ) : (
            <AuditTimeline kind="trailer" entityId={selectedTrailerId} />
          )}
        </div>
      </section>
    </aside>
  );
}
