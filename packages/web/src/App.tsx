import { useState, useCallback, useRef } from "react";
import { MapView } from "./map/MapView.js";
import { RightRail } from "./panels/RightRail.js";
import { useAlertFeed } from "./panels/AlertFeed.js";
import { useSuggestions } from "./panels/useSuggestions.js";
import { WsProvider, useWsEnvelope } from "./map/WsProvider.js";
import { makeEntityMaps } from "./map/wsClient.js";
import type { WsEnvelope } from "@mm/api";
import type { EntityMaps } from "./map/wsClient.js";

/**
 * The web shell (VIZ-01 / UI-01 / VIZ-05 / UI-02).
 *
 * Layout: a thin header over a split view — the animated OL map (centerpiece,
 * flex: 1) plus the right-rail operator panels (fixed-width sidebar).
 *
 * Data flow (FIX 16 — consolidated single WebSocket):
 *  - `WsProvider` (wrapping App) opens ONE `/api/ws` WebSocket and fans out
 *    parsed envelopes to all subscribers via a shared `SubscriberRegistry`.
 *  - MapView subscribes via `useWsEnvelope` (from WsProvider) for animation.
 *  - App subscribes via `useWsEnvelope` for the alert feed.
 *  - KpiDashboard subscribes via `useWsEnvelope` for live KPI updates.
 *  - All three consumers share the SAME socket, seq counter, and entity maps —
 *    eliminating the three-socket seq-gap/resync churn of the prior design.
 *
 * Map click wiring (VIZ-05 / VIZ-07):
 *  - MapView accepts `onTrailerSelect` and `onHubSelect` callbacks.
 *  - App manages `selectedTrailerId` + `selectedHubId` as React state, kept
 *    mutually exclusive (selecting one clears the other) so the right rail shows
 *    a single detail at a time.
 *  - RightRail receives both to drive TrailerDetail/AuditTimeline (VIZ-05) and
 *    the new HubDetail panel (VIZ-07).
 */

/** Inner shell — lives inside WsProvider so useWsEnvelope has context. */
function AppInner(): React.JSX.Element {
  const [selectedTrailerId, setSelectedTrailerId] = useState<string | null>(null);
  const [selectedHubId, setSelectedHubId] = useState<string | null>(null);

  // VIZ-17: single toggle governing BOTH the map overlay AND the rail feed
  // (default OFF so the map starts clean; user opts in for the demo moment).
  const [showSuggestions, setShowSuggestions] = useState(false);

  const handleTrailerSelect = useCallback((id: string | null) => {
    setSelectedTrailerId(id);
    // Selecting a trailer clears any hub selection (single active detail).
    if (id !== null) setSelectedHubId(null);
  }, []);

  const handleHubSelect = useCallback((id: string | null) => {
    setSelectedHubId(id);
    // Selecting a hub clears any trailer selection (single active detail).
    if (id !== null) setSelectedTrailerId(null);
  }, []);

  // --- Alert feed (UI-01) --------------------------------------------------
  // Subscribes to the shared ws bus via WsProvider (FIX 16: no extra socket).
  const { feed, onExceptionsNew, onExceptionsResolved } = useAlertFeed();

  // --- Advisory Suggestions feed (VIZ-17) ----------------------------------
  // Dispatch ONLY on the TICK branch (Pitfall 7: suggestions is transient,
  // NEVER on SnapshotPayload — a reconnect must not re-flash old suggestions).
  const { feed: suggestionFeed, onSuggestions } = useSuggestions();
  const entityMapsRef = useRef<EntityMaps>(makeEntityMaps());

  const onAlertEnvelope = useCallback(
    (envelope: WsEnvelope): void => {
      if (envelope.type === "snapshot") {
        if (envelope.payload.exceptionsOpen.length > 0) {
          onExceptionsNew(envelope.payload.exceptionsOpen);
        }
        // NOTE: do NOT dispatch suggestions on snapshot — Pitfall 7 (transient).
      } else {
        if (envelope.payload.exceptionsNew !== undefined) {
          onExceptionsNew(envelope.payload.exceptionsNew);
        }
        if (envelope.payload.exceptionsResolved !== undefined) {
          onExceptionsResolved(envelope.payload.exceptionsResolved);
        }
        // VIZ-17: dispatch suggestion outcomes from the TICK branch only.
        if (envelope.payload.suggestions !== undefined) {
          onSuggestions(envelope.payload.suggestions, envelope.simMs);
        }
      }
    },
    [onExceptionsNew, onExceptionsResolved, onSuggestions],
  );

  useWsEnvelope(onAlertEnvelope, entityMapsRef.current);

  return (
    <div className="app">
      <header className="app__header">Middle-Mile Live Map</header>
      <div className="app__body">
        <MapView
          onTrailerSelect={handleTrailerSelect}
          onHubSelect={handleHubSelect}
          showSuggestions={showSuggestions}
        />
        <RightRail
          feed={feed}
          selectedTrailerId={selectedTrailerId}
          selectedHubId={selectedHubId}
          suggestionFeed={suggestionFeed}
          showSuggestions={showSuggestions}
          onToggleSuggestions={setShowSuggestions}
        />
      </div>
    </div>
  );
}

/** App root — wraps the shell in WsProvider to provide the shared ws bus. */
export function App(): React.JSX.Element {
  return (
    <WsProvider>
      <AppInner />
    </WsProvider>
  );
}
