/**
 * MoneySlide tests (TDD RED → GREEN).
 *
 * Tests the pure money-slide logic extracted from MoneySlide:
 *  - `formatDelta`: formats a signed delta value (+ = optimizer worse, - = optimizer wins)
 *  - `winClass`: returns win/loss/neutral CSS class for a metric delta
 *  - `comparisonRows`: ordered row definitions for baseline-vs-optimizer comparison
 *  - `metricsForWin`: returns the set of metric fields where optimizer wins
 *
 * The business logic is all pure functions — no DOM/React required.
 */
import { describe, expect, it } from "vitest";
import {
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

function makeComparison(
  overrides: Partial<KpiComparison> = {},
): KpiComparison {
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

// ---------------------------------------------------------------------------
// formatDelta
// ---------------------------------------------------------------------------

describe("formatDelta", () => {
  it("formats a negative rehandleScore delta as negative minutes (optimizer wins)", () => {
    // delta = optimizer - baseline; -73 = optimizer wins by 73 min
    expect(formatDelta("rehandleScore", -73)).toContain("-73");
  });

  it("formats a positive delta with a + prefix (optimizer is worse)", () => {
    const formatted = formatDelta("rehandleScore", 10);
    expect(formatted).toMatch(/^\+/);
  });

  it("formats a zero delta as ±0", () => {
    const formatted = formatDelta("rehandleScore", 0);
    expect(formatted).toBe("±0.0 min");
  });

  it("formats utilizationScore delta as a signed decimal", () => {
    const pos = formatDelta("utilizationScore", 5.5);
    expect(pos).toContain("+");
    const neg = formatDelta("utilizationScore", -3.0);
    expect(neg).toContain("-");
  });

  it("includes a unit suffix for rehandleScore", () => {
    const formatted = formatDelta("rehandleScore", -73);
    expect(formatted).toContain("min");
  });
});

// ---------------------------------------------------------------------------
// winClass
// ---------------------------------------------------------------------------

describe("winClass", () => {
  it("returns 'win' for a delta < 0 (optimizer lower cost wins)", () => {
    // For cost metrics: negative delta means optimizer is better
    expect(winClass("rehandleScore", -73)).toBe("win");
  });

  it("returns 'loss' for a delta > 0 (optimizer higher cost, worse)", () => {
    expect(winClass("rehandleScore", 5)).toBe("loss");
  });

  it("returns 'neutral' for zero delta", () => {
    expect(winClass("rehandleScore", 0)).toBe("neutral");
  });

  it("returns 'neutral' for utilizationScore delta of 0", () => {
    expect(winClass("utilizationScore", 0)).toBe("neutral");
  });

  it("returns 'win' for negative utilizationScore delta (lower penalty = win)", () => {
    expect(winClass("utilizationScore", -2)).toBe("win");
  });
});

// ---------------------------------------------------------------------------
// comparisonRows
// ---------------------------------------------------------------------------

describe("comparisonRows", () => {
  it("returns at least one row definition", () => {
    const rows: readonly ComparisonRowDef[] = comparisonRows();
    expect(rows.length).toBeGreaterThan(0);
  });

  it("includes rehandleScore as a row", () => {
    const rows = comparisonRows();
    const fields = rows.map((r) => r.field);
    expect(fields).toContain("rehandleScore");
  });

  it("includes utilizationScore as a row", () => {
    const rows = comparisonRows();
    const fields = rows.map((r) => r.field);
    expect(fields).toContain("utilizationScore");
  });

  it("every row has a non-empty label", () => {
    const rows = comparisonRows();
    for (const row of rows) {
      expect(row.label.length).toBeGreaterThan(0);
    }
  });

  it("every row has a field key string", () => {
    const rows = comparisonRows();
    for (const row of rows) {
      expect(typeof row.field).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// metricsForWin
// ---------------------------------------------------------------------------

describe("metricsForWin", () => {
  it("returns fields where optimizer wins (delta < 0) on the DEMO_SEED=42 comparison", () => {
    const comparison = makeComparison();
    const wins = metricsForWin(comparison);
    // With seed=42: rehandleScore delta = -73, so optimizer wins
    expect(wins.has("rehandleScore")).toBe(true);
  });

  it("does not return fields where delta is 0 (neutral, not a win)", () => {
    const comparison = makeComparison();
    const wins = metricsForWin(comparison);
    // utilizationScore delta = 0 in the calibrated comparison
    expect(wins.has("utilizationScore")).toBe(false);
  });

  it("returns empty set when optimizer wins nothing", () => {
    const comparison = makeComparison({
      deltas: { rehandleScore: 10, utilizationScore: 5 },
    });
    const wins = metricsForWin(comparison);
    expect(wins.size).toBe(0);
  });

  it("returns all fields when optimizer wins everything", () => {
    const comparison = makeComparison({
      deltas: { rehandleScore: -73, utilizationScore: -5 },
    });
    const wins = metricsForWin(comparison);
    expect(wins.has("rehandleScore")).toBe(true);
    expect(wins.has("utilizationScore")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: formatting on the actual DEMO_SEED comparison shape
// ---------------------------------------------------------------------------

describe("money slide on DEMO_SEED=42 shape", () => {
  const comparison = makeComparison();

  it("shows optimizer winning on rehandle (delta is clearly negative)", () => {
    const delta = comparison.deltas.rehandleScore;
    expect(delta).toBeLessThan(0);
  });

  it("delta formatted shows optimizer's win legibly", () => {
    const formatted = formatDelta("rehandleScore", comparison.deltas.rehandleScore);
    // Should start with minus to show optimizer won
    expect(formatted).toMatch(/^-/);
  });

  it("win class for rehandleScore with negative delta is 'win'", () => {
    expect(winClass("rehandleScore", comparison.deltas.rehandleScore)).toBe("win");
  });
});
