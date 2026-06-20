import { useState, useCallback, useRef } from "react";
import { MapView } from "./map/MapView.js";
import { RightRail } from "./panels/RightRail.js";
import { useAlertFeed } from "./panels/AlertFeed.js";
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
 * Map click wiring (VIZ-05):
 *  - MapView accepts an `onTrailerSelect` callback.
 *  - App manages `selectedTrailerId` as React state.
 *  - RightRail receives `selectedTrailerId` to drive TrailerDetail + AuditTimeline.
 */

/** Inner shell — lives inside WsProvider so useWsEnvelope has context. */
function AppInner(): React.JSX.Element {
  const [selectedTrailerId, setSelectedTrailerId] = useState<string | null>(null);

  const handleTrailerSelect = useCallback((id: string | null) => {
    setSelectedTrailerId(id);
  }, []);

  // --- Alert feed (UI-01) --------------------------------------------------
  // Subscribes to the shared ws bus via WsProvider (FIX 16: no extra socket).
  const { feed, onExceptionsNew, onExceptionsResolved } = useAlertFeed();
  const entityMapsRef = useRef<EntityMaps>(makeEntityMaps());

  const onAlertEnvelope = useCallback(
    (envelope: WsEnvelope): void => {
      if (envelope.type === "snapshot") {
        if (envelope.payload.exceptionsOpen.length > 0) {
          onExceptionsNew(envelope.payload.exceptionsOpen);
        }
      } else {
        if (envelope.payload.exceptionsNew !== undefined) {
          onExceptionsNew(envelope.payload.exceptionsNew);
        }
        if (envelope.payload.exceptionsResolved !== undefined) {
          onExceptionsResolved(envelope.payload.exceptionsResolved);
        }
      }
    },
    [onExceptionsNew, onExceptionsResolved],
  );

  useWsEnvelope(onAlertEnvelope, entityMapsRef.current);

  return (
    <div className="app">
      <header className="app__header">Middle-Mile Live Map</header>
      <div className="app__body">
        <MapView onTrailerSelect={handleTrailerSelect} />
        <RightRail feed={feed} selectedTrailerId={selectedTrailerId} />
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
