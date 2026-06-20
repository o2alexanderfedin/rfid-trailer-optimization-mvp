import { useState, useCallback } from "react";
import { MapView } from "./map/MapView.js";
import { RightRail } from "./panels/RightRail.js";
import { useAlertFeed } from "./panels/AlertFeed.js";
import { useWsEnvelope, makeEntityMaps } from "./map/wsClient.js";
import type { WsEnvelope } from "@mm/api";
import type { EntityMaps } from "./map/wsClient.js";
import { useRef } from "react";

/**
 * The web shell (VIZ-01 / UI-01 / VIZ-05 / UI-02).
 *
 * Layout: a thin header over a split view — the animated OL map (centerpiece,
 * flex: 1) plus the right-rail operator panels (fixed-width sidebar).
 *
 * Data flow:
 *  - The ws envelope channel drives both the map (via MapView's internal hook)
 *    AND the alert feed (via useAlertFeed). To avoid opening two WebSockets,
 *    the ws subscription lives in App and the envelope handler fans out:
 *      → exception deltas → alert feed React state (UI-01)
 *      → everything else  → MapView receives via onEnvelope prop
 *
 *    NOTE: MapView already subscribes to its own WebSocket internally via
 *    useWsEnvelope. Rather than refactor MapView's internals, App uses a
 *    *second* useWsEnvelope hook whose sole purpose is to feed the alert panel.
 *    This is acceptable for the MVP (two WS connections to the same endpoint)
 *    but could be consolidated into a shared context in a future refactor.
 *
 * Map click wiring (VIZ-05):
 *  - MapView accepts an `onTrailerSelect` callback.
 *  - App manages `selectedTrailerId` as React state.
 *  - RightRail receives `selectedTrailerId` to drive TrailerDetail + AuditTimeline.
 */
export function App(): React.JSX.Element {
  const [selectedTrailerId, setSelectedTrailerId] = useState<string | null>(null);

  const handleTrailerSelect = useCallback((id: string | null) => {
    setSelectedTrailerId(id);
  }, []);

  // --- Alert feed (UI-01) --------------------------------------------------
  // A second ws connection dedicated to the alert panel. This keeps MapView's
  // internal animation loop decoupled from the panel state updates.
  const { feed, onExceptionsNew, onExceptionsResolved } = useAlertFeed();
  const entityMapsRef = useRef<EntityMaps>(makeEntityMaps());

  const onAlertEnvelope = useCallback(
    (envelope: WsEnvelope, _maps: EntityMaps): void => {
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
