/**
 * HubBalance tests (FLOW-05, P2) — pure helpers + jsdom render (`ui` lane).
 *
 * Two surfaces (mirrors MoneySlide's discipline):
 *  1. Pure helpers (no DOM): formatBalance / crossDockRatio / heatClass.
 *  2. Component render branches: fetch `GET /api/hubs/:id/detail` →
 *     inbound/outbound counts + heat-keyed accent; loading + error branches.
 *
 * The shared MSW handlers file does NOT register a balance-specific hub-detail,
 * so each render test installs a per-test `server.use(http.get(...))` override.
 *
 * Strict TS: no `any`, no `as`-casting of fixtures.
 */
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../test/msw/server.js";
import {
  HubBalance,
  formatBalance,
  crossDockRatio,
  heatClass,
} from "./HubBalance.js";
import type { HubDetailDto, HubInventoryBalanceDto } from "../api/client.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function hubDetail(
  hubId: string,
  inventoryBalance: HubInventoryBalanceDto,
): HubDetailDto {
  return { hubId, trailers: [], inventoryBalance };
}

/** Register a one-off `/api/hubs/:id/detail` handler returning `detail`. */
function serveHubDetail(detail: HubDetailDto): void {
  server.use(
    http.get(`/api/hubs/${detail.hubId}/detail`, () => HttpResponse.json(detail)),
  );
}

// ---------------------------------------------------------------------------
// formatBalance
// ---------------------------------------------------------------------------

describe("formatBalance", () => {
  it("formats inbound/outbound as a compact summary", () => {
    expect(formatBalance(12, 8)).toBe("12 in / 8 out");
  });

  it("handles a zero balance", () => {
    expect(formatBalance(0, 0)).toBe("0 in / 0 out");
  });
});

// ---------------------------------------------------------------------------
// crossDockRatio
// ---------------------------------------------------------------------------

describe("crossDockRatio", () => {
  it("is outbound / (inbound + outbound)", () => {
    expect(crossDockRatio(6, 2)).toBeCloseTo(0.25);
    expect(crossDockRatio(2, 6)).toBeCloseTo(0.75);
  });

  it("is 0.5 for a perfectly balanced cross-dock", () => {
    expect(crossDockRatio(5, 5)).toBeCloseTo(0.5);
  });

  it("returns 0 for an idle hub (no division by zero)", () => {
    expect(crossDockRatio(0, 0)).toBe(0);
  });

  it("is 1.0 for pure outflow and 0.0 for pure inflow", () => {
    expect(crossDockRatio(0, 4)).toBe(1);
    expect(crossDockRatio(4, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// heatClass
// ---------------------------------------------------------------------------

describe("heatClass", () => {
  it("is 'idle' when no freight either way", () => {
    expect(heatClass(0, 0)).toBe("idle");
  });

  it("escalates with total throughput", () => {
    expect(heatClass(1, 1)).toBe("cool"); // total 2  (< 5)
    expect(heatClass(5, 5)).toBe("warm"); // total 10 (< 15)
    expect(heatClass(10, 10)).toBe("hot"); // total 20 (>= 15)
  });

  it("is symmetric in inbound/outbound (depends on the total only)", () => {
    expect(heatClass(3, 9)).toBe(heatClass(9, 3));
  });
});

// ---------------------------------------------------------------------------
// <HubBalance /> — jsdom render (ui lane)
// ---------------------------------------------------------------------------

describe("<HubBalance /> (jsdom ui lane)", () => {
  it("shows the loading placeholder before the fetch resolves", () => {
    server.use(http.get("/api/hubs/MEM/detail", () => new Promise<never>(() => {})));

    render(<HubBalance hubId="MEM" />);

    expect(screen.getByTestId("hub-balance")).toBeInTheDocument();
    expect(screen.getByText("Loading balance…")).toBeInTheDocument();
  });

  it("renders the inbound/outbound counts + summary once the fetch resolves", async () => {
    serveHubDetail(hubDetail("MEM", { inbound: 12, outbound: 8 }));

    render(<HubBalance hubId="MEM" />);

    await waitFor(() => {
      expect(screen.getByTestId("hub-balance-inbound")).toBeInTheDocument();
    });

    expect(screen.getByTestId("hub-balance-inbound")).toHaveTextContent("12");
    expect(screen.getByTestId("hub-balance-outbound")).toHaveTextContent("8");
    expect(screen.getByTestId("hub-balance-summary")).toHaveTextContent(
      "12 in / 8 out",
    );
    // total 20 ⇒ hot
    expect(screen.getByTestId("hub-balance")).toHaveAttribute("data-heat", "hot");
  });

  it("renders a zero balance with the idle heat for an empty hub", async () => {
    serveHubDetail(hubDetail("ATL", { inbound: 0, outbound: 0 }));

    render(<HubBalance hubId="ATL" />);

    await waitFor(() => {
      expect(screen.getByTestId("hub-balance-summary")).toBeInTheDocument();
    });

    expect(screen.getByTestId("hub-balance-summary")).toHaveTextContent(
      "0 in / 0 out",
    );
    expect(screen.getByTestId("hub-balance")).toHaveAttribute("data-heat", "idle");
  });

  it("renders the error branch when the fetch fails", async () => {
    server.use(
      http.get(
        "/api/hubs/MEM/detail",
        () => new HttpResponse(null, { status: 500 }),
      ),
    );

    render(<HubBalance hubId="MEM" />);

    await waitFor(() => {
      expect(screen.getByText("Failed to load hub balance.")).toBeInTheDocument();
    });
    expect(screen.getByTestId("hub-balance")).toBeInTheDocument();
  });
});
