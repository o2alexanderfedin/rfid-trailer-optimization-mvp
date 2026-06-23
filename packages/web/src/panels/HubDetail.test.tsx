/**
 * HubDetail tests (VIZ-07..11) — jsdom `ui` lane (RTL + MSW + fake timers).
 *
 * Two surfaces (mirrors TrailerDetail's discipline):
 *  1. Pure formatters (no DOM): dwell, utilization, ETA-estimate, driver duty.
 *  2. Component render branches: fetch `GET /api/hubs/:id/detail` → compact rows
 *     (status, live dwell, util %, pkg count, next hub + EST eta, driver duty +
 *     remaining drive minutes), live-ticking dwell from ws `simMs`, click-through
 *     to the reused VIZ-05 TrailerDetail, per-row open exceptions (ws-filtered).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import type { ExceptionItem, WsEnvelope } from "@mm/api";
import { server } from "../../test/msw/server.js";
import {
  HubDetail,
  formatDwell,
  formatUtilPct,
  formatEtaEstimate,
  dutyBucketFor,
  dutyStatusLabel,
  formatDriveMinutes,
} from "./HubDetail.js";
import { WsContext, makeSubscriberRegistry } from "../map/WsProvider.js";
import { makeEntityMaps } from "../map/wsClient.js";
import type { HubDetailDto, HubTrailerDto } from "../api/client.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function trailer(over: Partial<HubTrailerDto> & Pick<HubTrailerDto, "trailerId">): HubTrailerDto {
  return {
    trailerId: over.trailerId,
    status: over.status ?? "docked",
    dockDoorId: over.dockDoorId ?? null,
    assignedPackageIds: over.assignedPackageIds ?? ["P-1", "P-2", "P-3"],
    driver: over.driver ?? {
      driverId: "D003",
      dutyStatus: "resting",
      remainingDriveMinutes: 0,
    },
    rearToNose: over.rearToNose ?? [{ depth: 0, loadBlockIds: ["P-1"] }],
    utilization: over.utilization ?? 0.78,
    nextHubId: over.nextHubId ?? "ATL",
    arrivedAtMs: over.arrivedAtMs ?? 60_000,
    estimatedEtaMs: over.estimatedEtaMs ?? 1_200_000,
    etaIsEstimate: over.etaIsEstimate ?? true,
  };
}

const HUB_DETAIL: HubDetailDto = {
  hubId: "DAL",
  trailers: [
    trailer({
      trailerId: "TRL-014",
      status: "docked",
      arrivedAtMs: 60_000, // arrived at sim 1 min
      driver: { driverId: "D003", dutyStatus: "resting", remainingDriveMinutes: 0 },
    }),
    trailer({
      trailerId: "TRL-022",
      status: "arrived",
      nextHubId: "ORD",
      driver: { driverId: "D007", dutyStatus: "driving", remainingDriveMinutes: 214 },
    }),
  ],
};

function mockHubDetail(detail: HubDetailDto): void {
  server.use(http.get("/api/hubs/:id/detail", () => HttpResponse.json(detail)));
}

function mockEmptyPlan(): void {
  // The click-through TrailerDetail fetches the plan; serve a small one.
  server.use(
    http.get("/api/trailers/:id/plan", ({ params }) =>
      HttpResponse.json({
        trailerId: String(params["id"]),
        rearToNose: [{ depth: 0, loadBlockIds: ["P-1", "P-2"] }],
        instructions: { trailerId: String(params["id"]), zones: [], text: "" },
        explanation: "LIFO-correct plan.",
      }),
    ),
  );
}

// A test ws context + helper to push envelopes (drives live dwell + exceptions).
function makeCtx() {
  return { registry: makeSubscriberRegistry(), maps: makeEntityMaps() };
}
const SPEED_PAUSED = { multiplier: 0, tickIntervalMs: 500, simSpeed: 0, paused: true } as const;
function snapshotEnv(simMs: number, open: readonly ExceptionItem[] = []): WsEnvelope {
  return {
    v: 1,
    type: "snapshot",
    seq: 1,
    simMs,
    speed: SPEED_PAUSED,
    payload: { trailers: [], hubs: [], routes: [], exceptionsOpen: open },
  };
}

function renderHub(hubId: string | null, ctx = makeCtx()) {
  return {
    ctx,
    ...render(
      <WsContext.Provider value={ctx}>
        <HubDetail hubId={hubId} />
      </WsContext.Provider>,
    ),
  };
}

// ===========================================================================
// Pure formatters
// ===========================================================================

describe("formatDwell", () => {
  it("returns minutes elapsed since arrival", () => {
    // sim 13 min, arrived at 1 min → 12m dwell.
    expect(formatDwell(13 * 60_000, 60_000)).toBe("12m");
  });
  it("clamps negative to 0m (clock not yet caught up)", () => {
    expect(formatDwell(0, 60_000)).toBe("0m");
  });
  it("returns an em-dash when arrival is unknown", () => {
    expect(formatDwell(60_000, null)).toBe("—");
  });
});

describe("formatUtilPct", () => {
  it("formats a ratio as a whole percent", () => {
    expect(formatUtilPct(0.78)).toBe("78%");
  });
  it("returns an em-dash for null utilization", () => {
    expect(formatUtilPct(null)).toBe("—");
  });
});

describe("formatEtaEstimate", () => {
  it("marks an estimate with a leading ~ and minutes-to-go", () => {
    // eta at 20 min, now 6 min → ~14m, estimate.
    expect(formatEtaEstimate(20 * 60_000, 6 * 60_000, true)).toBe("~14m");
  });
  it("returns an em-dash when no eta is known", () => {
    expect(formatEtaEstimate(null, 0, true)).toBe("—");
  });
});

describe("dutyBucketFor / dutyStatusLabel", () => {
  it("maps the FMCSA statuses to a bucket and a human label", () => {
    expect(dutyBucketFor("driving")).toBe(0);
    expect(dutyBucketFor("on_break")).toBe(1);
    expect(dutyBucketFor("resting")).toBe(2);
    expect(dutyStatusLabel("on_break")).toBe("on break");
    expect(dutyStatusLabel("driving")).toBe("driving");
  });
});

describe("formatDriveMinutes", () => {
  it("formats remaining legal drive minutes", () => {
    expect(formatDriveMinutes(214)).toBe("214m left");
    expect(formatDriveMinutes(0)).toBe("0m left");
  });
});

// ===========================================================================
// Component render branches
// ===========================================================================

describe("HubDetail render — no selection", () => {
  it("renders the prompt when no hub is selected (no fetch)", () => {
    renderHub(null);
    expect(screen.getByTestId("hub-detail")).toBeInTheDocument();
    expect(screen.getByTestId("hub-detail-prompt")).toBeInTheDocument();
  });
});

describe("HubDetail render — loaded hub", () => {
  it("renders the hub header and one row per trailer at the hub", async () => {
    mockHubDetail(HUB_DETAIL);
    const { ctx } = renderHub("DAL");
    // Anchor the live clock so dwell is computable.
    act(() => ctx.registry.dispatch(snapshotEnv(13 * 60_000)));

    // Header shows the hub id.
    expect(await screen.findByText(/DAL/)).toBeInTheDocument();

    const rows = await screen.findAllByTestId("hub-trailer-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("TRL-014")).toBeInTheDocument();
    expect(screen.getByText("TRL-022")).toBeInTheDocument();
  });

  it("shows status, live dwell, utilization %, package count, and next hub per row", async () => {
    mockHubDetail(HUB_DETAIL);
    const { ctx } = renderHub("DAL");
    act(() => ctx.registry.dispatch(snapshotEnv(13 * 60_000)));

    const rows = await screen.findAllByTestId("hub-trailer-row");
    const row14 = rows.find((r) => within(r).queryByText("TRL-014"));
    expect(row14).toBeDefined();
    const r = within(row14!);
    // Live dwell: sim 13m − arrived 1m = 12m.
    expect(r.getByText(/12m/)).toBeInTheDocument();
    // Utilization %.
    expect(r.getByText(/78%/)).toBeInTheDocument();
    // Package count (3 assigned).
    expect(r.getByText(/3 pkg/)).toBeInTheDocument();
    // Next hub.
    expect(r.getByText(/ATL/)).toBeInTheDocument();
  });

  it("shows the driver's duty status AND remaining legal drive minutes (the hero datum)", async () => {
    mockHubDetail(HUB_DETAIL);
    const { ctx } = renderHub("DAL");
    act(() => ctx.registry.dispatch(snapshotEnv(13 * 60_000)));

    const rows = await screen.findAllByTestId("hub-trailer-row");
    const row22 = rows.find((r) => within(r).queryByText("TRL-022"));
    const r = within(row22!);
    expect(r.getByText(/D007/)).toBeInTheDocument();
    expect(r.getByText(/driving/)).toBeInTheDocument();
    expect(r.getByText(/214m left/)).toBeInTheDocument();
    // The duty indicator carries a bucket data attribute (number AND bucket).
    expect(r.getByTestId("hub-trailer-duty")).toHaveAttribute("data-duty-bucket", "0");
  });

  it("labels the ETA as an estimate (~) for a parked trailer", async () => {
    mockHubDetail(HUB_DETAIL);
    const { ctx } = renderHub("DAL");
    act(() => ctx.registry.dispatch(snapshotEnv(6 * 60_000)));

    const rows = await screen.findAllByTestId("hub-trailer-row");
    const row14 = rows.find((r) => within(r).queryByText("TRL-014"))!;
    // estimatedEtaMs = 1_200_000 (20m), now 6m → ~14m, marked an estimate.
    expect(within(row14).getByText(/~14m/)).toBeInTheDocument();
  });

  it("shows a per-row exceptions badge filtered by the trailer's entityId (VIZ-10)", async () => {
    mockHubDetail(HUB_DETAIL);
    const { ctx } = renderHub("DAL");
    act(() =>
      ctx.registry.dispatch(
        snapshotEnv(13 * 60_000, [
          {
            id: "ex-1",
            kind: "wrongTrailer",
            severity: "high",
            entityId: "TRL-014",
            reason: "bad",
            recommendedAction: "fix",
            simMs: 1000,
          },
        ]),
      ),
    );

    const rows = await screen.findAllByTestId("hub-trailer-row");
    const row14 = rows.find((r) => within(r).queryByText("TRL-014"))!;
    const row22 = rows.find((r) => within(r).queryByText("TRL-022"))!;
    // The exceptions badge appears on TRL-014 (matching entityId), not TRL-022.
    expect(within(row14).getByTestId("hub-trailer-exceptions")).toBeInTheDocument();
    expect(within(row22).queryByTestId("hub-trailer-exceptions")).not.toBeInTheDocument();
  });

  it("renders the empty state for a hub with no trailers", async () => {
    mockHubDetail({ hubId: "EMPTY", trailers: [] });
    renderHub("EMPTY");
    expect(await screen.findByTestId("hub-detail-empty")).toBeInTheDocument();
  });

  it("renders an error state when the fetch fails", async () => {
    server.use(
      http.get("/api/hubs/:id/detail", () => new HttpResponse(null, { status: 500 })),
    );
    renderHub("BAD");
    expect(await screen.findByText(/^Error:/)).toBeInTheDocument();
  });
});

describe("HubDetail click-through (VIZ-09 — reuse TrailerDetail)", () => {
  it("clicking a trailer row opens the reused VIZ-05 TrailerDetail plan", async () => {
    vi.useRealTimers();
    mockHubDetail(HUB_DETAIL);
    mockEmptyPlan();
    const { ctx } = renderHub("DAL");
    act(() => ctx.registry.dispatch(snapshotEnv(13 * 60_000)));

    const rows = await screen.findAllByTestId("hub-trailer-row");
    const row14 = rows.find((r) => within(r).queryByText("TRL-014"))!;

    const user = userEvent.setup();
    await user.click(within(row14).getByRole("button"));

    // The reused TrailerDetail renders the rear→nose load order for the trailer.
    expect(await screen.findByTestId("trailer-detail")).toBeInTheDocument();
    expect(await screen.findByText("Load Order (rear → nose)")).toBeInTheDocument();
    // A back affordance returns to the hub list.
    expect(screen.getByTestId("hub-detail-back")).toBeInTheDocument();
  });
});

// Live-dwell ticking uses fake timers; isolate so click-through (real timers) is clean.
describe("HubDetail live dwell ticking", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("re-renders the dwell as sim time advances (live)", async () => {
    mockHubDetail(HUB_DETAIL);
    const ctx = makeCtx();
    render(
      <WsContext.Provider value={ctx}>
        <HubDetail hubId="DAL" />
      </WsContext.Provider>,
    );

    // Resolve the fetch under fake timers.
    await vi.waitFor(() => {
      expect(screen.getAllByTestId("hub-trailer-row").length).toBe(2);
    });

    // Anchor running clock at sim 1m (= arrival) so dwell starts at 0m.
    act(() =>
      ctx.registry.dispatch({
        v: 1,
        type: "snapshot",
        seq: 1,
        simMs: 60_000,
        speed: { multiplier: 1, tickIntervalMs: 500, simSpeed: 120, paused: false },
        payload: { trailers: [], hubs: [], routes: [], exceptionsOpen: [] },
      }),
    );

    const row14 = screen
      .getAllByTestId("hub-trailer-row")
      .find((r) => within(r).queryByText("TRL-014"))!;
    expect(within(row14).getByTestId("hub-trailer-dwell")).toHaveTextContent(
      "dwell 0m",
    );

    // Advance wall time 1s → simSpeed 120 → +120000 sim-ms (= 2 sim-min) dwell.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const refreshed = screen
      .getAllByTestId("hub-trailer-row")
      .find((r) => within(r).queryByText("TRL-014"))!;
    expect(within(refreshed).getByTestId("hub-trailer-dwell")).not.toHaveTextContent(
      "dwell 0m",
    );
  });
});
