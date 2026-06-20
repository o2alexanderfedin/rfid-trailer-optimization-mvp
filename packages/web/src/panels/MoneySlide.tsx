/**
 * MoneySlide (UI-04) — before/after baseline-vs-optimizer comparison.
 *
 * The demo's closing argument: a side-by-side comparison showing the optimizer
 * beating the FIFO baseline on the same seeded inputs (KEYSTONE-b).
 *
 * Data: `GET /api/kpis/comparison` (computed on DEMO_SEED=42, byte-identical
 * across calls — deterministic by construction, not theater: T-05-18 / T-05-05).
 *
 * Design (frontend-design skill):
 *  - Clear side-by-side layout: Baseline | Optimizer | Delta
 *  - Win indicators: green badge for optimizer wins, red for losses, gray neutral
 *  - Legible: large per-metric rows, high contrast, signed deltas
 *  - Honest: both planners on the same inputs via the same scoring gate (P8)
 *
 * Pure helpers (unit-testable):
 *  - `formatDelta`: signed delta string with unit suffix
 *  - `winClass`: "win" | "loss" | "neutral" from delta direction
 *  - `comparisonRows`: ordered row definitions
 *  - `metricsForWin`: set of fields where optimizer wins
 *
 * Strict TS: no `any`, no `as`, React 19.
 */
import { useState, useEffect } from "react";
import { fetchKpiComparison } from "../api/client.js";
import type { KpiComparison } from "../api/client.js";

// ---------------------------------------------------------------------------
// Public types (exported for tests)
// ---------------------------------------------------------------------------

/** One row in the comparison table. */
export interface ComparisonRowDef {
  readonly field: keyof KpiComparison["deltas"];
  readonly label: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

type ScoreField = keyof KpiComparison["deltas"];

/**
 * Format a signed delta value for display.
 *  - Negative = optimizer wins (lower cost) → "-73.0 min"
 *  - Positive = optimizer is worse          → "+5.0 min"
 *  - Zero                                   → "±0.0 min"
 *
 * All score fields are in "minutes" (rehandle time cost or utilization penalty).
 */
export function formatDelta(field: ScoreField, delta: number): string {
  // Both rehandleScore and utilizationScore are in minutes (or dimensionless penalty)
  const suffix = field === "rehandleScore" ? " min" : "";
  if (delta === 0) return `±0.0${suffix}`;
  const sign = delta < 0 ? "" : "+";
  return `${sign}${delta.toFixed(1)}${suffix}`;
}

/**
 * CSS class indicating win/loss/neutral for a given metric delta.
 * For cost metrics: negative delta = optimizer lower cost = WIN.
 */
export function winClass(field: ScoreField, delta: number): "win" | "loss" | "neutral" {
  void field; // field reserved for future directional metrics (e.g. utilization → higher is better)
  if (delta < 0) return "win";
  if (delta > 0) return "loss";
  return "neutral";
}

/** Ordered comparison row definitions. */
export function comparisonRows(): readonly ComparisonRowDef[] {
  return [
    { field: "rehandleScore", label: "Rehandle Cost (min)" },
    { field: "utilizationScore", label: "Utilization Penalty" },
  ] as const;
}

/**
 * Returns the set of metric fields where the optimizer wins
 * (delta < 0 = lower cost = better for cost metrics).
 */
export function metricsForWin(comparison: KpiComparison): ReadonlySet<ScoreField> {
  const wins = new Set<ScoreField>();
  for (const row of comparisonRows()) {
    const delta = comparison.deltas[row.field];
    if (delta < 0) wins.add(row.field);
  }
  return wins;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type LoadState = "loading" | "error" | "loaded";

/**
 * Format a score value for display in the comparison table.
 * Scores are in minutes (or dimensionless); show 1 decimal place.
 */
function formatScore(value: number): string {
  return value.toFixed(1);
}

/**
 * MoneySlide — the demo's before/after closer (UI-04).
 *
 * Fetches `GET /api/kpis/comparison` on mount and renders a clear
 * baseline-vs-optimizer table with signed deltas and win indicators.
 * Seed-deterministic: same seed → same numbers every time (KEYSTONE-b).
 */
export function MoneySlide(): React.JSX.Element {
  const [comparison, setComparison] = useState<KpiComparison | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");

  useEffect(() => {
    const ac = new AbortController();
    fetchKpiComparison(ac.signal)
      .then((c) => {
        setComparison(c);
        setLoadState("loaded");
      })
      .catch(() => {
        setLoadState("error");
      });
    return () => {
      ac.abort();
    };
  }, []);

  if (loadState === "loading") {
    return (
      <div className="money-slide" data-testid="money-slide">
        <p className="money-slide__loading">Loading comparison...</p>
      </div>
    );
  }

  if (loadState === "error" || comparison === null) {
    return (
      <div className="money-slide" data-testid="money-slide">
        <p className="money-slide__error">Failed to load comparison data.</p>
      </div>
    );
  }

  const rows = comparisonRows();
  const wins = metricsForWin(comparison);

  return (
    <div className="money-slide" data-testid="money-slide">
      {/* Header */}
      <div className="money-slide__header">
        <h3 className="money-slide__title">Optimizer vs Baseline</h3>
        <p className="money-slide__subtitle">
          Same seeded inputs — different planners
        </p>
      </div>

      {/* Column headers */}
      <div className="money-slide__table" role="table" aria-label="Baseline vs optimizer comparison">
        <div className="money-slide__thead" role="rowgroup">
          <div className="money-slide__row money-slide__row--header" role="row">
            <div className="money-slide__cell money-slide__cell--metric" role="columnheader">
              Metric
            </div>
            <div className="money-slide__cell money-slide__cell--baseline" role="columnheader">
              FIFO Baseline
            </div>
            <div className="money-slide__cell money-slide__cell--optimizer" role="columnheader">
              Optimizer
            </div>
            <div className="money-slide__cell money-slide__cell--delta" role="columnheader">
              Delta
            </div>
          </div>
        </div>

        {/* Rows */}
        <div className="money-slide__tbody" role="rowgroup">
          {rows.map((row) => {
            const baseVal = comparison.baseline[row.field];
            const optVal = comparison.optimizer[row.field];
            const delta = comparison.deltas[row.field];
            const cls = winClass(row.field, delta);
            const isWin = wins.has(row.field);

            return (
              <div
                key={row.field}
                className={`money-slide__row money-slide__row--${cls}`}
                role="row"
                data-testid={`money-row-${row.field}`}
                data-win={isWin ? "true" : "false"}
              >
                <div className="money-slide__cell money-slide__cell--metric" role="cell">
                  {row.label}
                </div>
                <div
                  className="money-slide__cell money-slide__cell--baseline"
                  role="cell"
                  data-testid={`baseline-${row.field}`}
                >
                  {formatScore(baseVal)}
                </div>
                <div
                  className={`money-slide__cell money-slide__cell--optimizer money-slide__optimizer-val--${cls}`}
                  role="cell"
                  data-testid={`optimizer-${row.field}`}
                >
                  {formatScore(optVal)}
                </div>
                <div
                  className={`money-slide__cell money-slide__cell--delta money-slide__delta--${cls}`}
                  role="cell"
                  data-testid={`delta-${row.field}`}
                >
                  <span className={`money-slide__win-badge money-slide__win-badge--${cls}`}>
                    {cls === "win" ? "WIN" : cls === "loss" ? "LOSS" : ""}
                  </span>
                  {formatDelta(row.field, delta)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Summary line */}
      <div className="money-slide__summary">
        {wins.size > 0 ? (
          <p className="money-slide__summary-win" data-testid="money-slide-summary">
            Optimizer wins on {wins.size} of {rows.length} metric
            {rows.length !== 1 ? "s" : ""}
          </p>
        ) : (
          <p className="money-slide__summary-neutral" data-testid="money-slide-summary">
            No significant difference on this scenario
          </p>
        )}
        <p className="money-slide__seed-note">
          Seed-deterministic: same numbers every run (DEMO_SEED=42)
        </p>
      </div>
    </div>
  );
}
