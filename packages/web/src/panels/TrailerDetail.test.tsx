/**
 * TrailerDetail tests (TDD RED→GREEN).
 *
 * Tests the pure logic helpers for the trailer plan detail panel:
 *   - formatRearToNose: converts rearToNose slices to display rows
 *   - extractZoneSummary: builds a zone-by-zone summary from instructions
 *   - getPlanStatus: returns the loading status given a plan (or null)
 *
 * The component renders React JSX; the pure logic helpers are extracted so
 * tests run in Node (matching the project's existing test pattern).
 */
import { describe, expect, it } from "vitest";
import {
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
