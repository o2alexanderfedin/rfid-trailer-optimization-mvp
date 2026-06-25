/**
 * RightRail — operator panel sidebar composing AlertFeed + TrailerDetail
 * + KpiDashboard + MoneySlide (UI-03 / UI-04).
 *
 * Layout (frontend-design skill):
 *  - Fixed-width right rail alongside the full-height map.
 *  - Top: AlertFeed (scrollable, most-recent-first exception feed)
 *  - Bottom: tabbed detail section with three tabs:
 *      - "Plan" → TrailerDetail / AuditTimeline (VIZ-05 / UI-02)
 *      - "KPIs" → KpiDashboard (UI-03) — live operational metrics
 *      - "vs Baseline" → MoneySlide (UI-04) — before/after money slide
 *  - Clean, legible operator aesthetic: neutral dark background, clear section
 *    headings, consistent padding, high-contrast text.
 *
 * The RightRail is a pure layout component — no data-fetching.
 */
import { useEffect, useState } from "react";
import { AlertFeed } from "./AlertFeed.js";
import { TrailerDetail } from "./TrailerDetail.js";
import { AuditTimeline } from "./AuditTimeline.js";
import { HubDetail } from "./HubDetail.js";
import { KpiDashboard } from "./KpiDashboard.js";
import { DeliveryKpi } from "./DeliveryKpi.js";
import { MoneySlide } from "./MoneySlide.js";
import { SpeedControl } from "./SpeedControl.js";
import type { FeedEntry } from "./AlertFeed.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DetailTab = "plan" | "history" | "hub" | "kpis" | "money";

interface RightRailProps {
  /** The sorted realtime exception feed (from useAlertFeed). */
  readonly feed: readonly FeedEntry[];
  /** The currently selected trailer id (from map click), or null. */
  readonly selectedTrailerId: string | null;
  /** VIZ-07: the currently selected hub id (from a hub map click), or null. */
  readonly selectedHubId?: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Right-rail operator panel: alert feed + tabbed detail panels.
 *
 * The panel is split vertically:
 *  - Top:    AlertFeed (scrollable exception list, most recent first)
 *  - Bottom: Tabbed view:
 *              "Plan"       → TrailerDetail / AuditTimeline
 *              "KPIs"       → KpiDashboard (UI-03)
 *              "vs Baseline"→ MoneySlide (UI-04)
 */
export function RightRail({
  feed,
  selectedTrailerId,
  selectedHubId = null,
}: RightRailProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<DetailTab>("kpis");

  // VIZ-07: when a hub is clicked on the map, auto-focus the Hub tab; when a
  // trailer is clicked, auto-focus the Plan tab — mirroring how a selection
  // surfaces its detail without an extra click.
  useEffect(() => {
    if (selectedHubId !== null) setActiveTab("hub");
  }, [selectedHubId]);
  useEffect(() => {
    if (selectedTrailerId !== null) setActiveTab("plan");
  }, [selectedTrailerId]);

  return (
    <aside className="right-rail" data-testid="right-rail" aria-label="Operator panels">
      {/* --- Speed of Time gauge (fixed-height, decoupled from the map) ---- */}
      <SpeedControl />

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

      {/* --- Detail / KPI / MoneySlide (tabbed) --------------------------- */}
      <section className="right-rail__section right-rail__section--detail">
        <header className="right-rail__section-header">
          <h2 className="right-rail__section-title">
            {activeTab === "kpis"
              ? "Live KPIs"
              : activeTab === "money"
                ? "vs Baseline"
                : activeTab === "hub"
                  ? selectedHubId !== null
                    ? `Hub: ${selectedHubId}`
                    : "Hub Detail"
                  : selectedTrailerId !== null
                    ? `Trailer: ${selectedTrailerId}`
                    : "Trailer Detail"}
          </h2>
          <div className="right-rail__tabs" role="tablist">
            {/* KPI Dashboard tab (always visible) */}
            <button
              className={`right-rail__tab${activeTab === "kpis" ? " right-rail__tab--active" : ""}`}
              role="tab"
              aria-selected={activeTab === "kpis"}
              data-testid="tab-kpis"
              onClick={() => setActiveTab("kpis")}
            >
              KPIs
            </button>
            {/* Money Slide tab (always visible) */}
            <button
              className={`right-rail__tab${activeTab === "money" ? " right-rail__tab--active" : ""}`}
              role="tab"
              aria-selected={activeTab === "money"}
              data-testid="tab-money"
              onClick={() => setActiveTab("money")}
            >
              vs Baseline
            </button>
            {/* Hub detail tab (VIZ-07 — only when a hub is selected) */}
            {selectedHubId !== null && (
              <button
                className={`right-rail__tab${activeTab === "hub" ? " right-rail__tab--active" : ""}`}
                role="tab"
                aria-selected={activeTab === "hub"}
                data-testid="tab-hub"
                onClick={() => setActiveTab("hub")}
              >
                Hub
              </button>
            )}
            {/* Plan detail tabs (only when trailer is selected) */}
            {selectedTrailerId !== null && (
              <>
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
              </>
            )}
          </div>
        </header>

        <div className="right-rail__detail-scroll">
          {activeTab === "kpis" ? (
            <>
              <DeliveryKpi />
              <KpiDashboard />
            </>
          ) : activeTab === "money" ? (
            <MoneySlide />
          ) : activeTab === "hub" ? (
            <HubDetail hubId={selectedHubId} />
          ) : activeTab === "plan" || selectedTrailerId === null ? (
            <TrailerDetail trailerId={selectedTrailerId} />
          ) : (
            <AuditTimeline kind="trailer" entityId={selectedTrailerId} />
          )}
        </div>
      </section>
    </aside>
  );
}
