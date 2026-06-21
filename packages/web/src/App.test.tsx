/**
 * App.test.tsx — jsdom render of the web shell root (the `ui` lane).
 *
 * `<App/>` is the top-level composition: it wraps `AppInner` in `WsProvider`
 * (one shared `/api/ws` socket) and lays out a thin header over the split view
 * of the animated OL `MapView` (centerpiece) and the `RightRail` operator panels.
 *
 * In jsdom the OpenLayers map cannot fully render (no real canvas/WebGL), and
 * the live WebSocket is the MSW `ws` channel — that's fine. This test asserts the
 * STRUCTURAL WIRING the shell is responsible for:
 *  - the header chrome ("Middle-Mile Live Map")
 *  - the map container mount (`data-testid="map"`, owned by MapView)
 *  - the right-rail mount (`data-testid="right-rail"`, owned by RightRail)
 *  - that the shared `/api/ws` socket is opened exactly once (the WsProvider)
 *
 * All HTTP (`/api/hubs`, `/api/routes`, `/api/kpis`, `/api/exceptions`,
 * `/api/sim/speed`) and the `/api/ws` channel are served by the shared MSW
 * server (started/reset by the jsdom setup). Per-test overrides — when needed —
 * go through `server.use(...)`, never the shared handler file.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { server } from "../test/msw/server.js";
import { api } from "../test/msw/handlers.js";
import { App } from "./App.js";

/**
 * OpenLayers' `Map` constructor wires a `ResizeObserver` to track its target's
 * size. jsdom does not implement `ResizeObserver`, so without a stub the OL map
 * inside MapView throws on mount and the whole App render crashes. The map can't
 * paint a real canvas in jsdom anyway (no WebGL) — we only need the container to
 * mount — so a no-op `ResizeObserver` stub is the honest, minimal shim. Installed
 * test-locally (never observing/measuring anything), guarded so it never clobbers
 * a real implementation if one is present.
 */
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    class ResizeObserverStub implements ResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = ResizeObserverStub;
  }
});

describe("<App /> (jsdom ui lane)", () => {
  it("renders the header chrome with the live-map title", () => {
    render(<App />);
    expect(screen.getByText("Middle-Mile Live Map")).toBeInTheDocument();
  });

  it("mounts the OL map container (MapView centerpiece, data-testid=\"map\")", () => {
    render(<App />);
    // The OL map can't fully render in jsdom, but MapView's container div mounts.
    expect(screen.getByTestId("map")).toBeInTheDocument();
  });

  it("mounts the right-rail operator panels (RightRail, data-testid=\"right-rail\")", () => {
    render(<App />);
    const rail = screen.getByTestId("right-rail");
    expect(rail).toBeInTheDocument();
    // RightRail is the accessible operator-panel landmark.
    expect(rail).toHaveAttribute("aria-label", "Operator panels");
  });

  it("lays out the header above a body holding BOTH the map and the right rail", () => {
    const { container } = render(<App />);

    const header = container.querySelector(".app__header");
    expect(header).not.toBeNull();
    expect(header).toHaveTextContent("Middle-Mile Live Map");

    // The split body wraps the map (flex: 1) alongside the fixed-width rail.
    const body = container.querySelector(".app__body");
    expect(body).not.toBeNull();
    const bodyEl = body as HTMLElement;
    expect(within(bodyEl).getByTestId("map")).toBeInTheDocument();
    expect(within(bodyEl).getByTestId("right-rail")).toBeInTheDocument();
  });

  it("opens exactly ONE shared /api/ws socket via WsProvider (FIX 16)", async () => {
    // Add a second connection listener on the SAME shared `/api/ws` ws link so we
    // can count how many sockets the app subtree opens. The consolidated
    // single-socket design (FIX 16) must open exactly one for the whole subtree
    // — MapView, the alert feed, and KpiDashboard all share it.
    let connections = 0;
    server.use(
      api.addEventListener("connection", () => {
        connections += 1;
      }),
    );

    render(<App />);

    // Structural proof the WsProvider-wrapped subtree mounted end-to-end.
    await waitFor(() => {
      expect(screen.getByTestId("map")).toBeInTheDocument();
      expect(screen.getByTestId("right-rail")).toBeInTheDocument();
    });

    // The single socket connects after mount (the WsProvider effect runs).
    await waitFor(() => {
      expect(connections).toBe(1);
    });
  });
});
