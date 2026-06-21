/**
 * MoneySlide tests — pure helpers (node-friendly) + jsdom render (`ui` lane).
 *
 * The exported pure helpers (formatDelta / winClass / comparisonRows /
 * metricsForWin) were already covered, but the COMPONENT render branches were
 * not — that gap is why MoneySlide.tsx sat at ~37%. This file keeps the helper
 * coverage AND renders the real <MoneySlide /> against the MSW
 * `/api/kpis/comparison` boundary to exercise every JSX branch:
 *
 *   - loading        : pre-fetch "Loading comparison..." placeholder
 *   - loaded (win)   : optimizer beats baseline on both metrics
 *                      → signed deltas, WIN badges, win row classes, summary count
 *   - loaded (mixed) : one win, one loss — exercises +delta / LOSS / loss class
 *   - loaded (neutral): both deltas 0 → ±0.0, no win, neutral summary line
 *   - error          : non-ok response → "Failed to load comparison data."
 *
 * The shared MSW handlers file does NOT register `/api/kpis/comparison`, so each
 * render test installs a per-test `server.use(http.get(...))` override (the jsdom
 * setup resets handlers between tests). The shared handlers.ts is never edited.
 *
 * Strict TS: no `any`, no `as`-casting of fixtures.
 */
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../test/msw/server.js";
import {
  MoneySlide,
  formatDelta,
  winClass,
  comparisonRows,
  metricsForWin,
  type ComparisonRowDef,
} from "./MoneySlide.js";
import type { KpiComparison } from "../api/client.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeComparison(overrides: Partial<KpiComparison> = {}): KpiComparison {
  return {
    baseline: overrides.baseline ?? {
      rehandleScore: 73,
      utilizationScore: 0,
    },
    optimizer: overrides.optimizer ?? {
      rehandleScore: 0,
      utilizationScore: 0,
    },
    deltas: overrides.deltas ?? {
      rehandleScore: -73, // optimizer - baseline (negative = optimizer wins)
      utilizationScore: 0,
    },
  };
}

/** Optimizer beats the FIFO baseline on BOTH metrics (both deltas negative). */
const WIN_COMPARISON: KpiComparison = {
  baseline: { rehandleScore: 95, utilizationScore: 30 },
  optimizer: { rehandleScore: 22, utilizationScore: 12 },
  deltas: { rehandleScore: -73, utilizationScore: -18 },
};

/** One win (rehandle) + one loss (utilization positive delta). */
const MIXED_COMPARISON: KpiComparison = {
  baseline: { rehandleScore: 95, utilizationScore: 10 },
  optimizer: { rehandleScore: 22, utilizationScore: 15 },
  deltas: { rehandleScore: -73, utilizationScore: 5 },
};

/** No movement on either metric (both deltas zero → neutral). */
const NEUTRAL_COMPARISON: KpiComparison = {
  baseline: { rehandleScore: 50, utilizationScore: 20 },
  optimizer: { rehandleScore: 50, utilizationScore: 20 },
  deltas: { rehandleScore: 0, utilizationScore: 0 },
};

/** Register a one-off `/api/kpis/comparison` handler returning `cmp`. */
function serveComparison(cmp: KpiComparison): void {
  server.use(http.get("/api/kpis/comparison", () => HttpResponse.json(cmp)));
}

/** Rendered text of a row's delta cell (via its stable test id). */
function deltaText(field: string): string {
  return screen.getByTestId(`delta-${field}`).textContent ?? "";
}

// ---------------------------------------------------------------------------
// formatDelta
// ---------------------------------------------------------------------------

describe("formatDelta", () => {
  it("formats a negative rehandleScore delta as negative minutes (optimizer wins)", () => {
    // delta = optimizer - baseline; -73 = optimizer wins by 73 min
    expect(formatDelta("rehandleScore", -73)).toBe("-73.0 min");
  });

  it("formats a positive delta with a + prefix (optimizer is worse)", () => {
    expect(formatDelta("rehandleScore", 10)).toBe("+10.0 min");
  });

  it("formats a zero delta as ±0", () => {
    expect(formatDelta("rehandleScore", 0)).toBe("±0.0 min");
  });

  it("formats utilizationScore deltas WITHOUT the min suffix (dimensionless)", () => {
    expect(formatDelta("utilizationScore", 5.5)).toBe("+5.5");
    expect(formatDelta("utilizationScore", -3.0)).toBe("-3.0");
    expect(formatDelta("utilizationScore", 0)).toBe("±0.0");
  });
});

// ---------------------------------------------------------------------------
// winClass
// ---------------------------------------------------------------------------

describe("winClass", () => {
  it("returns 'win' for a delta < 0 (optimizer lower cost wins)", () => {
    expect(winClass("rehandleScore", -73)).toBe("win");
  });

  it("returns 'loss' for a delta > 0 (optimizer higher cost, worse)", () => {
    expect(winClass("rehandleScore", 5)).toBe("loss");
  });

  it("returns 'neutral' for zero delta", () => {
    expect(winClass("rehandleScore", 0)).toBe("neutral");
  });

  it("returns 'win' for negative utilizationScore delta (lower penalty = win)", () => {
    expect(winClass("utilizationScore", -2)).toBe("win");
  });
});

// ---------------------------------------------------------------------------
// comparisonRows
// ---------------------------------------------------------------------------

describe("comparisonRows", () => {
  it("returns the two ordered metric rows (rehandle then utilization)", () => {
    const rows: readonly ComparisonRowDef[] = comparisonRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.field).toBe("rehandleScore");
    expect(rows[1]?.field).toBe("utilizationScore");
  });

  it("every row has a non-empty label and a string field key", () => {
    for (const row of comparisonRows()) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(typeof row.field).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// metricsForWin
// ---------------------------------------------------------------------------

describe("metricsForWin", () => {
  it("collects every field where the optimizer wins (delta < 0)", () => {
    const wins = metricsForWin(WIN_COMPARISON);
    expect(wins.has("rehandleScore")).toBe(true);
    expect(wins.has("utilizationScore")).toBe(true);
    expect(wins.size).toBe(2);
  });

  it("excludes neutral (delta === 0) fields", () => {
    const wins = metricsForWin(makeComparison());
    expect(wins.has("rehandleScore")).toBe(true);
    expect(wins.has("utilizationScore")).toBe(false);
  });

  it("returns empty set when optimizer wins nothing", () => {
    const wins = metricsForWin(
      makeComparison({ deltas: { rehandleScore: 10, utilizationScore: 5 } }),
    );
    expect(wins.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// <MoneySlide /> — jsdom render (ui lane)
// ---------------------------------------------------------------------------

describe("<MoneySlide /> (jsdom ui lane)", () => {
  it("shows the loading placeholder before the fetch resolves", () => {
    // Hold the fetch open (never resolves) so the loading branch is observed.
    server.use(http.get("/api/kpis/comparison", () => new Promise<never>(() => {})));

    render(<MoneySlide />);

    expect(screen.getByTestId("money-slide")).toBeInTheDocument();
    expect(screen.getByText("Loading comparison...")).toBeInTheDocument();
  });

  it("renders the side-by-side table with signed deltas + WIN badges when the optimizer wins both", async () => {
    serveComparison(WIN_COMPARISON);

    render(<MoneySlide />);

    // Header lands after the comparison resolves.
    await waitFor(() => {
      expect(screen.getByText("Optimizer vs Baseline")).toBeInTheDocument();
    });

    // Baseline / optimizer score cells are formatted to 1dp.
    expect(screen.getByTestId("baseline-rehandleScore")).toHaveTextContent("95.0");
    expect(screen.getByTestId("optimizer-rehandleScore")).toHaveTextContent("22.0");
    expect(screen.getByTestId("baseline-utilizationScore")).toHaveTextContent("30.0");
    expect(screen.getByTestId("optimizer-utilizationScore")).toHaveTextContent("12.0");

    // Signed delta strings (rehandle carries the min suffix; utilization does not).
    expect(deltaText("rehandleScore")).toContain("-73.0 min");
    expect(deltaText("utilizationScore")).toContain("-18.0");

    // Both rows are flagged as wins, carry the win class + WIN badge.
    const rehandleRow = screen.getByTestId("money-row-rehandleScore");
    expect(rehandleRow).toHaveAttribute("data-win", "true");
    expect(rehandleRow).toHaveClass("money-slide__row--win");
    expect(
      within(screen.getByTestId("delta-rehandleScore")).getByText("WIN"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("delta-utilizationScore")).getByText("WIN"),
    ).toBeInTheDocument();

    // Summary counts both wins.
    expect(screen.getByTestId("money-slide-summary")).toHaveTextContent(
      "Optimizer wins on 2 of 2 metrics",
    );
  });

  it("renders +delta, a LOSS badge, and the loss class for a worse metric", async () => {
    serveComparison(MIXED_COMPARISON);

    render(<MoneySlide />);

    await waitFor(() => {
      expect(screen.getByTestId("delta-utilizationScore")).toBeInTheDocument();
    });

    // The losing (positive-delta) row.
    const utilRow = screen.getByTestId("money-row-utilizationScore");
    expect(utilRow).toHaveAttribute("data-win", "false");
    expect(utilRow).toHaveClass("money-slide__row--loss");
    expect(deltaText("utilizationScore")).toContain("+5.0");
    expect(
      within(screen.getByTestId("delta-utilizationScore")).getByText("LOSS"),
    ).toBeInTheDocument();

    // The winning row is still a win.
    expect(screen.getByTestId("money-row-rehandleScore")).toHaveAttribute(
      "data-win",
      "true",
    );

    // Summary counts exactly one win of two.
    expect(screen.getByTestId("money-slide-summary")).toHaveTextContent(
      "Optimizer wins on 1 of 2 metrics",
    );
  });

  it("renders ±0.0 deltas, no win badge, and the neutral summary when nothing moves", async () => {
    serveComparison(NEUTRAL_COMPARISON);

    render(<MoneySlide />);

    await waitFor(() => {
      expect(screen.getByTestId("delta-rehandleScore")).toBeInTheDocument();
    });

    // Zero deltas render the ± sentinel (with/without the min suffix).
    expect(deltaText("rehandleScore")).toContain("±0.0 min");
    expect(deltaText("utilizationScore")).toContain("±0.0");

    // Neither row is a win; both carry the neutral class with no badge text.
    const rehandleRow = screen.getByTestId("money-row-rehandleScore");
    expect(rehandleRow).toHaveAttribute("data-win", "false");
    expect(rehandleRow).toHaveClass("money-slide__row--neutral");
    expect(
      within(screen.getByTestId("delta-rehandleScore")).queryByText("WIN"),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("delta-rehandleScore")).queryByText("LOSS"),
    ).not.toBeInTheDocument();

    // The neutral summary line, not the win line.
    expect(screen.getByTestId("money-slide-summary")).toHaveTextContent(
      "No significant difference on this scenario",
    );
  });

  it("renders the error branch when the comparison fetch fails (null-data path)", async () => {
    server.use(
      http.get(
        "/api/kpis/comparison",
        () => new HttpResponse(null, { status: 500 }),
      ),
    );

    render(<MoneySlide />);

    await waitFor(() => {
      expect(screen.getByText("Failed to load comparison data.")).toBeInTheDocument();
    });
    // The shell is still present; the table never renders on the error branch.
    expect(screen.getByTestId("money-slide")).toBeInTheDocument();
    expect(screen.queryByText("Optimizer vs Baseline")).not.toBeInTheDocument();
  });
});
