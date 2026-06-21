/**
 * TrailerDetail tests (TDD RED→GREEN) — runs in the jsdom `ui` lane (`*.test.tsx`).
 *
 * Two complementary surfaces:
 *
 *  1. Pure logic helpers (Node-style, no DOM needed):
 *     - formatRearToNose: converts rearToNose slices to display rows
 *     - extractZoneSummary: builds a zone-by-zone summary from instructions
 *     - getPlanStatus: returns the loading status given a plan (or null)
 *
 *  2. Component render branches (jsdom + React Testing Library + MSW):
 *     TrailerDetail is async — `useTrailerPlan` fetches `GET /api/trailers/:id/plan`
 *     via `fetchTrailerPlan`. The render tests assert every visible branch:
 *       - null selection    → the "click a trailer" prompt (no fetch)
 *       - plan present       → header id + badge, rear→nose rows, zone
 *                             instructions, and the plain-English explanation
 *       - plan with no zones  → the instructions section is omitted
 *       - 404 → null plan    → the "no plan available" empty state
 *       - fetch failure      → the error state
 *
 * The shared MSW handler list does NOT model `/api/trailers/:id/plan`, so every
 * fetching test installs a per-test override with `server.use(...)`. The jsdom
 * setup starts/resets MSW between tests, so overrides do not leak.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../test/msw/server.js";
import {
  TrailerDetail,
  formatRearToNose,
  extractZoneSummary,
  getPlanStatus,
} from "./TrailerDetail.js";
import type { TrailerPlanDto, RearToNoseSlice, LoadingInstructions } from "../api/client.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SLICE_REAR: RearToNoseSlice = {
  depth: 0,
  loadBlockIds: ["pkg-a", "pkg-b"],
};
const SLICE_MID: RearToNoseSlice = {
  depth: 1,
  loadBlockIds: ["pkg-c"],
};
const SLICE_NOSE: RearToNoseSlice = {
  depth: 2,
  loadBlockIds: ["pkg-d", "pkg-e"],
};

const INSTRUCTIONS: LoadingInstructions = {
  trailerId: "T-1",
  zones: [
    {
      zone: "rear",
      blockIds: ["pkg-a", "pkg-b"],
      text: "Load pkg-a and pkg-b at the rear",
    },
    {
      zone: "nose",
      blockIds: ["pkg-d", "pkg-e"],
      text: "Load pkg-d and pkg-e at the nose",
    },
  ],
  text: "Load nose to rear: pkg-d, pkg-e, then pkg-a, pkg-b",
};

const PLAN: TrailerPlanDto = {
  trailerId: "T-1",
  rearToNose: [SLICE_REAR, SLICE_MID, SLICE_NOSE],
  instructions: INSTRUCTIONS,
  explanation: "Rear unloads first at HUB-A; nose unloads last at HUB-C.",
};

// ---------------------------------------------------------------------------
// formatRearToNose
// ---------------------------------------------------------------------------

describe("formatRearToNose", () => {
  it("returns an array with one row per non-empty slice", () => {
    const rows = formatRearToNose([SLICE_REAR, SLICE_MID, SLICE_NOSE]);
    expect(rows).toHaveLength(3);
  });

  it("each row has depth and a non-empty blockIds list", () => {
    const rows = formatRearToNose([SLICE_REAR]);
    expect(rows[0]?.depth).toBe(0);
    expect(rows[0]?.blockIds).toEqual(["pkg-a", "pkg-b"]);
  });

  it("returns rows ordered by depth ascending (rear → nose)", () => {
    // Input may be in any order; output must be sorted depth-ascending.
    const rows = formatRearToNose([SLICE_NOSE, SLICE_REAR, SLICE_MID]);
    expect(rows[0]?.depth).toBe(0);
    expect(rows[1]?.depth).toBe(1);
    expect(rows[2]?.depth).toBe(2);
  });

  it("filters out empty slices", () => {
    const empty: RearToNoseSlice = { depth: 99, loadBlockIds: [] };
    const rows = formatRearToNose([SLICE_REAR, empty]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.depth).toBe(0);
  });

  it("returns empty array for empty input", () => {
    expect(formatRearToNose([])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractZoneSummary
// ---------------------------------------------------------------------------

describe("extractZoneSummary", () => {
  it("returns one entry per zone", () => {
    const summary = extractZoneSummary(INSTRUCTIONS);
    expect(summary).toHaveLength(2);
  });

  it("each entry has zone name, block count, and text", () => {
    const summary = extractZoneSummary(INSTRUCTIONS);
    const rear = summary.find((z) => z.zone === "rear");
    expect(rear).toBeDefined();
    expect(rear?.blockCount).toBe(2);
    expect(rear?.text).toContain("pkg-a");
  });

  it("returns empty array for instructions with no zones", () => {
    const emptyInstr: LoadingInstructions = {
      trailerId: "T-1",
      zones: [],
      text: "",
    };
    expect(extractZoneSummary(emptyInstr)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getPlanStatus
// ---------------------------------------------------------------------------

describe("getPlanStatus", () => {
  it("returns 'loaded' when a plan is present", () => {
    expect(getPlanStatus(PLAN)).toBe("loaded");
  });

  it("returns 'no-plan' when plan is null", () => {
    expect(getPlanStatus(null)).toBe("no-plan");
  });

  it("returns 'no-plan' when plan has no slices", () => {
    const empty: TrailerPlanDto = {
      ...PLAN,
      rearToNose: [],
    };
    expect(getPlanStatus(empty)).toBe("no-plan");
  });
});

// ===========================================================================
// Component render branches (jsdom `ui` lane — React Testing Library + MSW)
// ===========================================================================

const FULL_PLAN: TrailerPlanDto = {
  trailerId: "T-100",
  rearToNose: [
    { depth: 0, loadBlockIds: ["B-1", "B-2"] },
    { depth: 1, loadBlockIds: ["B-3"] },
    // An empty slice — must be filtered out by formatRearToNose (no row).
    { depth: 2, loadBlockIds: [] },
  ],
  instructions: {
    trailerId: "T-100",
    zones: [
      { zone: "rear", blockIds: ["B-1", "B-2"], text: "Load B-1, B-2 at the door" },
      { zone: "nose", blockIds: ["B-3"], text: "Load B-3 toward the nose" },
    ],
    text: "Load rear to nose",
  },
  explanation: "LIFO-correct plan that unloads DFW freight first.",
};

/** Install a per-test override that serves a concrete plan DTO. */
function mockPlan(plan: TrailerPlanDto): void {
  server.use(http.get("/api/trailers/:id/plan", () => HttpResponse.json(plan)));
}

// ---------------------------------------------------------------------------
// No-selection (null) branch
// ---------------------------------------------------------------------------

describe("TrailerDetail render — no selection", () => {
  it("renders the click-a-trailer prompt when no trailer is selected", () => {
    render(<TrailerDetail trailerId={null} />);
    expect(screen.getByTestId("trailer-detail")).toBeInTheDocument();
    expect(screen.getByTestId("trailer-detail-prompt")).toHaveTextContent(
      "Click a trailer on the map to view its load plan.",
    );
  });

  it("does NOT render a plan header in the unselected state", () => {
    render(<TrailerDetail trailerId={null} />);
    expect(screen.queryByText("Plan loaded")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Loaded plan branch
// ---------------------------------------------------------------------------

describe("TrailerDetail render — loaded plan", () => {
  it("renders the trailer id header and the 'Plan loaded' badge", async () => {
    mockPlan(FULL_PLAN);
    render(<TrailerDetail trailerId="T-100" />);

    // Async: wait for the fetch to resolve and the badge to appear.
    expect(await screen.findByText("Plan loaded")).toBeInTheDocument();
    expect(screen.getByText("T-100")).toBeInTheDocument();
  });

  it("renders the rear→nose load order with depth labels and pkg counts", async () => {
    mockPlan(FULL_PLAN);
    render(<TrailerDetail trailerId="T-100" />);

    expect(
      await screen.findByText("Load Order (rear → nose)"),
    ).toBeInTheDocument();

    // depth 0 → "Rear (door)"; depth 1 → "Depth 1".
    expect(screen.getByText("Rear (door)")).toBeInTheDocument();
    expect(screen.getByText("Depth 1")).toBeInTheDocument();

    // Block ids joined with the pkg-count suffix.
    expect(screen.getByText("B-1, B-2 (2 pkg)")).toBeInTheDocument();
    expect(screen.getByText("B-3 (1 pkg)")).toBeInTheDocument();
  });

  it("filters out empty rear→nose slices (depth 2 has no blocks)", async () => {
    mockPlan(FULL_PLAN);
    render(<TrailerDetail trailerId="T-100" />);

    await screen.findByText("Plan loaded");

    expect(screen.queryByText("Depth 2")).not.toBeInTheDocument();
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  });

  it("renders the per-zone loading instructions", async () => {
    mockPlan(FULL_PLAN);
    render(<TrailerDetail trailerId="T-100" />);

    expect(await screen.findByText("Loading Instructions")).toBeInTheDocument();
    expect(screen.getByText("rear")).toBeInTheDocument();
    expect(screen.getByText("Load B-1, B-2 at the door")).toBeInTheDocument();
    expect(screen.getByText("nose")).toBeInTheDocument();
    expect(screen.getByText("Load B-3 toward the nose")).toBeInTheDocument();
  });

  it("renders the plain-English plan explanation", async () => {
    mockPlan(FULL_PLAN);
    render(<TrailerDetail trailerId="T-100" />);

    expect(await screen.findByText("Why This Plan")).toBeInTheDocument();
    expect(
      screen.getByText("LIFO-correct plan that unloads DFW freight first."),
    ).toBeInTheDocument();
  });

  it("omits the Loading Instructions section when the plan has no zones", async () => {
    const noZones: TrailerPlanDto = {
      ...FULL_PLAN,
      instructions: { trailerId: "T-100", zones: [], text: "" },
    };
    mockPlan(noZones);
    render(<TrailerDetail trailerId="T-100" />);

    // Plan still loads (rear→nose present) ...
    expect(
      await screen.findByText("Load Order (rear → nose)"),
    ).toBeInTheDocument();
    // ... but the zones section is suppressed by the `zones.length > 0` guard.
    expect(screen.queryByText("Loading Instructions")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// No-plan (404 → null) / empty-plan branch
// ---------------------------------------------------------------------------

describe("TrailerDetail render — no plan available", () => {
  it("renders the empty state when the plan endpoint 404s (null plan)", async () => {
    server.use(
      http.get(
        "/api/trailers/:id/plan",
        () => new HttpResponse(null, { status: 404 }),
      ),
    );
    render(<TrailerDetail trailerId="T-404" />);

    expect(
      await screen.findByText("No plan available for this trailer yet."),
    ).toBeInTheDocument();
    // The header still shows which trailer was selected.
    expect(screen.getByText("T-404")).toBeInTheDocument();
    // No load-order section in the empty state.
    expect(
      screen.queryByText("Load Order (rear → nose)"),
    ).not.toBeInTheDocument();
  });

  it("renders the empty state when the plan has zero rear→nose slices", async () => {
    const emptyPlan: TrailerPlanDto = {
      trailerId: "T-empty",
      rearToNose: [],
      instructions: { trailerId: "T-empty", zones: [], text: "" },
      explanation: "",
    };
    mockPlan(emptyPlan);
    render(<TrailerDetail trailerId="T-empty" />);

    expect(
      await screen.findByText("No plan available for this trailer yet."),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Error branch
// ---------------------------------------------------------------------------

describe("TrailerDetail render — error", () => {
  it("renders the error state when the fetch fails (non-404)", async () => {
    server.use(
      http.get(
        "/api/trailers/:id/plan",
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    render(<TrailerDetail trailerId="T-500" />);

    // useTrailerPlan surfaces the thrown error message in the error state.
    expect(await screen.findByText(/^Error:/)).toBeInTheDocument();
  });
});
