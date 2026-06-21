/**
 * MapView.browser.test.tsx — Vitest Browser Mode smoke test (the `browser` lane).
 *
 * Proves the real-Chromium lane works: a genuine OpenLayers `ol/Map` is created
 * against a real DOM + canvas (impossible under jsdom). It is a SMOKE test —
 * mount + dispose invariants only — not a pixel/interaction test:
 *
 *  - the `data-testid="map"` container mounts;
 *  - `data-map-instances` increments to exactly 1 (created-once discipline);
 *  - `data-map-net-live` is 1 (created − disposed; no leaked/duplicate map);
 *  - the Legend overlay renders inside the map container.
 *
 * MapView calls `/api/hubs` + `/api/routes` on mount; with no MSW worker started
 * those fetches fail and MapView degrades gracefully (basemap + live trailers
 * still usable — see its catch block), which is exactly the path this smoke test
 * exercises. It is wrapped in `WsProvider` because MapView uses `useWsEnvelope`;
 * the default context's no-op registry keeps the socket out of the smoke test.
 *
 * The mount container is sized explicitly: the app's flex layout (index.css) is
 * not loaded here, and OpenLayers refuses to render into a 0×0 container.
 */
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { MapView } from "./MapView.js";
import { WsProvider } from "./WsProvider.js";

describe("MapView (browser smoke)", () => {
  it("mounts a single real OpenLayers map with the Legend overlay", async () => {
    // Give the OL map a non-zero viewport (no app CSS in the test harness).
    const host = document.createElement("div");
    host.style.width = "640px";
    host.style.height = "480px";
    document.body.appendChild(host);

    const screen = await render(
      <WsProvider>
        <MapView />
      </WsProvider>,
      { container: host },
    );

    // The map container is present (locator auto-waits in browser mode).
    const map = screen.getByTestId("map");
    await expect.element(map).toBeInTheDocument();

    // The Legend overlay renders inside the map container.
    await expect.element(screen.getByTestId("map-legend")).toBeInTheDocument();

    // Read the leak-guard diagnostic attributes the component writes on mount.
    const el = map.element();
    expect(el.getAttribute("data-map-instances")).toBe("1");
    expect(el.getAttribute("data-map-net-live")).toBe("1");
    expect(el.getAttribute("data-trailer-source-instances")).toBe("1");
  });
});
