/**
 * RightRail (UI-03 / UI-04) — jsdom render test (the `ui` lane).
 *
 * RightRail is a pure layout component that composes the operator panels:
 *   - SpeedControl (the "speed of time" gauge)
 *   - AlertFeed    (the live exception feed, with a live count badge)
 *   - a tabbed detail section: KPIs (default) | vs Baseline | Plan | History
 *
 * These tests render the real component through the shared MSW boundary and
 * assert the sections render across the meaningful prop combinations:
 *   - empty vs populated `feed`
 *   - with vs without a `selectedTrailerId`
 * plus the tab-switching that gates which detail panel + which tabs appear.
 *
 * The child panels fetch through `/api/*`; the default shared handlers cover
 * `/api/kpis` and `/api/sim/speed`. The Plan tab fetches
 * `/api/trailers/:id/plan` and the "vs Baseline" tab fetches
 * `/api/kpis/comparison`, neither of which is in the shared handler file, so
 * those are added as per-test overrides via `server.use(...)` (the jsdom setup
 * resets handlers between tests, so the shared file is never edited).
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../test/msw/server.js";
import { RightRail } from "./RightRail.js";
import { WsProvider } from "../map/WsProvider.js";
import type { FeedEntry } from "./AlertFeed.js";
import type { TrailerPlanDto, KpiComparison, HubDetailDto } from "../api/client.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A small, contract-realistic feed entry. */
function makeEntry(overrides: Partial<FeedEntry> & Pick<FeedEntry, "id">): FeedEntry {
  return {
    id: overrides.id,
    kind: overrides.kind ?? "wrongTrailer",
    severity: overrides.severity ?? "high",
    entityId: overrides.entityId ?? "T-100",
    reason: overrides.reason ?? "Package scanned onto the wrong trailer",
    recommendedAction: overrides.recommendedAction ?? "Reroute to T-200",
    simMs: overrides.simMs ?? 1_000,
  };
}

const POPULATED_FEED: readonly FeedEntry[] = [
  makeEntry({ id: "ex-1", entityId: "T-100", simMs: 2_000 }),
  makeEntry({
    id: "ex-2",
    kind: "lowUtilization",
    severity: "low",
    entityId: "T-200",
    simMs: 1_000,
  }),
];

/** A plan DTO the per-test `/api/trailers/:id/plan` override returns. */
function makePlan(trailerId: string): TrailerPlanDto {
  return {
    trailerId,
    rearToNose: [{ depth: 0, loadBlockIds: ["B-1", "B-2"] }],
    instructions: {
      trailerId,
      zones: [{ zone: "Rear", blockIds: ["B-1", "B-2"], text: "Load B-1, B-2 at the door." }],
      text: "Loading instructions",
    },
    explanation: "Rear blocks unload first at DFW (LIFO-correct).",
  };
}

/** A comparison DTO the per-test `/api/kpis/comparison` override returns. */
const COMPARISON: KpiComparison = {
  baseline: { rehandleScore: 95, utilizationScore: 0.71 },
  optimizer: { rehandleScore: 35, utilizationScore: 0.82 },
  deltas: { rehandleScore: -60, utilizationScore: 0.11 },
};

/** A hub-detail DTO the per-test `/api/hubs/:id/detail` override returns. */
function makeHubDetail(hubId: string): HubDetailDto {
  return {
    hubId,
    inventoryBalance: { inbound: 0, outbound: 0 },
    trailers: [
      {
        trailerId: "TRL-014",
        status: "docked",
        dockDoorId: "D3",
        assignedPackageIds: ["P-1", "P-2"],
        driver: { driverId: "D003", dutyStatus: "resting", remainingDriveMinutes: 0 },
        rearToNose: [{ depth: 0, loadBlockIds: ["P-1"] }],
        utilization: 0.78,
        nextHubId: "ATL",
        arrivedAtMs: 60_000,
        estimatedEtaMs: 1_200_000,
        etaIsEstimate: true,
      },
    ],
  };
}

/** Render the rail under a real WsProvider (so SpeedControl behaves normally). */
function renderRail(props: {
  feed: readonly FeedEntry[];
  selectedTrailerId: string | null;
  selectedHubId?: string | null;
}): void {
  render(
    <WsProvider>
      <RightRail
        feed={props.feed}
        selectedTrailerId={props.selectedTrailerId}
        selectedHubId={props.selectedHubId ?? null}
      />
    </WsProvider>,
  );
}

// ---------------------------------------------------------------------------
// Structural sections — present across every prop combination
// ---------------------------------------------------------------------------

describe("<RightRail /> (jsdom ui lane)", () => {
  it("mounts the operator-panel landmark + speed gauge + feed + KPI default tab", () => {
    renderRail({ feed: [], selectedTrailerId: null });

    // The accessible aside landmark.
    const rail = screen.getByTestId("right-rail");
    expect(rail).toBeInTheDocument();
    expect(rail).toHaveAttribute("aria-label", "Operator panels");

    // The speed-of-time gauge section.
    expect(screen.getByTestId("speed-control")).toBeInTheDocument();

    // The live-exceptions section heading.
    expect(screen.getByText("Live Exceptions")).toBeInTheDocument();

    // The KPI tab is the default-active tab → KpiDashboard is mounted.
    expect(screen.getByTestId("kpi-dashboard")).toBeInTheDocument();
    expect(screen.getByTestId("tab-kpis")).toHaveAttribute("aria-selected", "true");
    // "Live KPIs" detail heading when the KPI tab is active.
    expect(screen.getByText("Live KPIs")).toBeInTheDocument();

    // Both always-visible tabs render.
    expect(screen.getByTestId("tab-kpis")).toBeInTheDocument();
    expect(screen.getByTestId("tab-money")).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Empty feed
  // -------------------------------------------------------------------------

  it("renders the empty-feed state with no exception-count badge", () => {
    renderRail({ feed: [], selectedTrailerId: null });

    // The AlertFeed empty placeholder is shown.
    expect(screen.getByTestId("alert-feed-empty")).toBeInTheDocument();
    expect(screen.getByText("No active exceptions")).toBeInTheDocument();

    // No count badge when the feed is empty.
    expect(screen.queryByTestId("exception-count")).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Populated feed
  // -------------------------------------------------------------------------

  it("renders a populated feed with a count badge and one entry per exception", () => {
    renderRail({ feed: POPULATED_FEED, selectedTrailerId: null });

    // The badge shows the feed length.
    const badge = screen.getByTestId("exception-count");
    expect(badge).toHaveTextContent(String(POPULATED_FEED.length));

    // The empty placeholder is gone; one entry renders per feed item.
    expect(screen.queryByTestId("alert-feed-empty")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("alert-feed-entry")).toHaveLength(POPULATED_FEED.length);

    // The entries' entity ids are visible.
    expect(screen.getByText("T-100")).toBeInTheDocument();
    expect(screen.getByText("T-200")).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // No trailer selected → no Plan / History tabs
  // -------------------------------------------------------------------------

  it("hides the Plan + History tabs when no trailer is selected", () => {
    renderRail({ feed: POPULATED_FEED, selectedTrailerId: null });

    // Only the two always-visible tabs exist; no Plan/History/Hub tabs.
    expect(screen.getByRole("tab", { name: "KPIs" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "vs Baseline" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Plan" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "History" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Hub" })).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // VIZ-07: hub selected → Hub tab appears, auto-focuses, and HubDetail renders
  // -------------------------------------------------------------------------

  it("shows the Hub tab and renders the HubDetail panel when a hub is selected", async () => {
    const hubId = "DAL";
    server.use(
      http.get("/api/hubs/:id/detail", () => HttpResponse.json(makeHubDetail(hubId))),
    );

    renderRail({ feed: [], selectedTrailerId: null, selectedHubId: hubId });

    // The Hub tab appears and is auto-focused (effect on selectedHubId).
    const hubTab = screen.getByRole("tab", { name: "Hub" });
    expect(hubTab).toBeInTheDocument();
    expect(hubTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("heading", { name: `Hub: ${hubId}` }),
    ).toBeInTheDocument();

    // The HubDetail panel mounts and the fetched trailer row renders.
    expect(screen.getByTestId("hub-detail")).toBeInTheDocument();
    expect(await screen.findByText("TRL-014")).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Trailer selected → Plan / History tabs appear + Plan panel renders
  // -------------------------------------------------------------------------

  it("shows the Plan + History tabs and renders the trailer plan when selected", async () => {
    const trailerId = "T-100";
    server.use(
      http.get("/api/trailers/:id/plan", () =>
        HttpResponse.json(makePlan(trailerId)),
      ),
    );

    renderRail({ feed: POPULATED_FEED, selectedTrailerId: trailerId });
    const user = userEvent.setup();

    // The trailer-scoped tabs now appear.
    const planTab = screen.getByRole("tab", { name: "Plan" });
    expect(planTab).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "History" })).toBeInTheDocument();

    // Switch to the Plan tab → TrailerDetail mounts and the header shows the id.
    await user.click(planTab);
    expect(screen.getByTestId("trailer-detail")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: `Trailer: ${trailerId}` }),
    ).toBeInTheDocument();

    // The plan fetch resolves → the load-order rows render.
    const detail = await screen.findByTestId("trailer-detail");
    expect(await within(detail).findByText(/Load Order/)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Tab switching → MoneySlide ("vs Baseline") section renders
  // -------------------------------------------------------------------------

  it("switches to the vs-Baseline tab and renders the money slide section", async () => {
    server.use(
      http.get("/api/kpis/comparison", () => HttpResponse.json(COMPARISON)),
    );

    renderRail({ feed: [], selectedTrailerId: null });
    const user = userEvent.setup();

    // Switch to the "vs Baseline" tab.
    const moneyTab = screen.getByTestId("tab-money");
    await user.click(moneyTab);

    // The KPI dashboard is replaced by the money slide section.
    expect(moneyTab).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("kpi-dashboard")).not.toBeInTheDocument();
    // The detail heading reflects the active tab.
    expect(
      screen.getByRole("heading", { name: "vs Baseline" }),
    ).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // History tab → AuditTimeline branch, then back to KPIs
  // -------------------------------------------------------------------------

  it("renders the audit timeline on the History tab and returns to KPIs", async () => {
    const trailerId = "T-100";
    server.use(
      http.get("/api/trailers/:id/plan", () =>
        HttpResponse.json(makePlan(trailerId)),
      ),
      // Empty history is a valid response (absence = empty timeline).
      http.get("/api/trailers/:id/history", () => HttpResponse.json([])),
    );

    renderRail({ feed: [], selectedTrailerId: trailerId });
    const user = userEvent.setup();

    // Switch to History → the AuditTimeline branch mounts.
    await user.click(screen.getByRole("tab", { name: "History" }));
    expect(await screen.findByTestId("audit-timeline")).toBeInTheDocument();
    // The KPI dashboard is no longer mounted on the History tab.
    expect(screen.queryByTestId("kpi-dashboard")).not.toBeInTheDocument();

    // Click back to the KPIs tab → KpiDashboard remounts (exercises the KPI
    // tab's onClick handler from a non-default active tab).
    await user.click(screen.getByTestId("tab-kpis"));
    expect(screen.getByTestId("tab-kpis")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("kpi-dashboard")).toBeInTheDocument();
    expect(screen.queryByTestId("audit-timeline")).not.toBeInTheDocument();
  });
});
