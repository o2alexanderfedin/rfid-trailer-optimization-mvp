import { MapView } from "./map/MapView.js";

/**
 * The web shell (VIZ-01). A thin header over the live OpenLayers USA map. The
 * map owns its own data lifecycle (fetches hubs + routes on mount, subscribes
 * to the ws snapshot channel for live trailers), so `App` stays a pure layout.
 */
export function App(): React.JSX.Element {
  return (
    <div className="app">
      <header className="app__header">Middle-Mile Live Map</header>
      <MapView />
    </div>
  );
}
