/**
 * TrailerDetail (VIZ-05) — Click-a-trailer plan detail panel.
 *
 * When a trailer is selected (via map click), this panel:
 *  1. Fetches `GET /api/trailers/:id/plan` using `fetchTrailerPlan`.
 *  2. Renders the rear→nose load order (depth 0 = rear door, ascending to nose).
 *  3. Renders per-zone loading instructions (from the Phase-2 `instructions` renderer).
 *  4. Renders the plain-English plan explanation (from `planExplanation`).
 *
 * Design (frontend-design skill):
 *  - Unselected / no-plan state shows a clear prompt (never crashes).
 *  - Loading state is shown while the fetch is in flight.
 *  - Rear-to-nose order is visually distinct (depth labels, block count).
 *  - Instructions are grouped by zone with clear headings.
 *  - Explanation text is readable body copy (no technical jargon from the field).
 *
 * Threat T-05-16: all text rendered via React's default escaping.
 * T-05-17: the map overlay (if any) is disposed by MapView on teardown;
 * this component is a side panel and does not hold overlay references itself.
 *
 * Pure logic helpers exported for Node unit tests.
 */
import { useState, useEffect } from "react";
import {
  fetchTrailerPlan,
  type TrailerPlanDto,
  type RearToNoseSlice,
  type LoadingInstructions,
} from "../api/client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A formatted rear→nose row for rendering. */
export interface RearToNoseRow {
  readonly depth: number;
  readonly blockIds: readonly string[];
}

/** A formatted zone summary entry for rendering. */
export interface ZoneSummaryEntry {
  readonly zone: string;
  readonly blockCount: number;
  readonly text: string;
}

/** Plan loading status. */
export type PlanStatus = "loaded" | "no-plan";

// ---------------------------------------------------------------------------
// Pure helpers (exported for Node unit tests)
// ---------------------------------------------------------------------------

/**
 * Convert rear→nose slices to display rows, sorted depth-ascending
 * and filtered to non-empty slices only.
 */
export function formatRearToNose(
  slices: readonly RearToNoseSlice[],
): RearToNoseRow[] {
  return [...slices]
    .filter((s) => s.loadBlockIds.length > 0)
    .sort((a, b) => a.depth - b.depth)
    .map((s) => ({ depth: s.depth, blockIds: [...s.loadBlockIds] }));
}

/**
 * Build a zone-by-zone summary from loading instructions.
 * Each entry has the zone name, block count, and the instruction text.
 */
export function extractZoneSummary(
  instr: LoadingInstructions,
): ZoneSummaryEntry[] {
  return instr.zones.map((z) => ({
    zone: z.zone,
    blockCount: z.blockIds.length,
    text: z.text,
  }));
}

/**
 * Determine the plan status:
 *  - "loaded"  — plan is present and has at least one slice
 *  - "no-plan" — plan is null or has no slices
 */
export function getPlanStatus(plan: TrailerPlanDto | null): PlanStatus {
  if (plan === null || plan.rearToNose.length === 0) return "no-plan";
  return "loaded";
}

// ---------------------------------------------------------------------------
// Hook: useTrailerPlan
// ---------------------------------------------------------------------------

/** Fetch state for the trailer plan. */
interface PlanFetchState {
  readonly plan: TrailerPlanDto | null;
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * Fetch the plan for a given trailerId on change.
 * Returns null plan + loading:false when trailerId is null (no selection).
 * Cancels in-flight requests via AbortController on id change or unmount.
 */
export function useTrailerPlan(trailerId: string | null): PlanFetchState {
  const [state, setState] = useState<PlanFetchState>({
    plan: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (trailerId === null) {
      setState({ plan: null, loading: false, error: null });
      return;
    }

    const controller = new AbortController();
    setState({ plan: null, loading: true, error: null });

    void fetchTrailerPlan(trailerId, controller.signal)
      .then((plan) => {
        if (!controller.signal.aborted) {
          setState({ plan, loading: false, error: null });
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          const msg =
            err instanceof Error ? err.message : "Failed to load plan";
          setState({ plan: null, loading: false, error: msg });
        }
      });

    return () => {
      controller.abort();
    };
  }, [trailerId]);

  return state;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface TrailerDetailProps {
  /** The currently selected trailer id, or null if nothing is selected. */
  readonly trailerId: string | null;
}

/**
 * TrailerDetail panel — click a trailer on the map to see its plan.
 *
 * Shows rear→nose load order, per-zone loading instructions, and the
 * plain-English plan explanation from the Phase-2 planner.
 */
export function TrailerDetail({ trailerId }: TrailerDetailProps): React.JSX.Element {
  const { plan, loading, error } = useTrailerPlan(trailerId);

  // Unselected state.
  if (trailerId === null) {
    return (
      <div className="trailer-detail" data-testid="trailer-detail">
        <div className="trailer-detail__prompt" data-testid="trailer-detail-prompt">
          Click a trailer on the map to view its load plan.
        </div>
      </div>
    );
  }

  // Loading state.
  if (loading) {
    return (
      <div className="trailer-detail" data-testid="trailer-detail">
        <div className="trailer-detail__loading">Loading plan for {trailerId}…</div>
      </div>
    );
  }

  // Error state.
  if (error !== null) {
    return (
      <div className="trailer-detail" data-testid="trailer-detail">
        <div className="trailer-detail__error">Error: {error}</div>
      </div>
    );
  }

  // No plan available.
  if (getPlanStatus(plan) === "no-plan") {
    return (
      <div className="trailer-detail" data-testid="trailer-detail">
        <div className="trailer-detail__header">
          <span className="trailer-detail__id">{trailerId}</span>
        </div>
        <div className="trailer-detail__empty">
          No plan available for this trailer yet.
        </div>
      </div>
    );
  }

  // Plan loaded — render detail.
  const rows = formatRearToNose(plan!.rearToNose);
  const zones = extractZoneSummary(plan!.instructions);

  return (
    <div className="trailer-detail" data-testid="trailer-detail">
      <div className="trailer-detail__header">
        <span className="trailer-detail__id">{trailerId}</span>
        <span className="trailer-detail__badge">Plan loaded</span>
      </div>

      {/* Rear→Nose load order */}
      <section className="trailer-detail__section">
        <h4 className="trailer-detail__section-title">Load Order (rear → nose)</h4>
        <ol className="trailer-detail__load-order">
          {rows.map((row) => (
            <li
              key={row.depth}
              className="trailer-detail__slice"
              data-depth={row.depth}
            >
              <span className="trailer-detail__depth">
                {row.depth === 0 ? "Rear (door)" : `Depth ${row.depth}`}
              </span>
              <span className="trailer-detail__blocks">
                {row.blockIds.join(", ")} ({row.blockIds.length} pkg)
              </span>
            </li>
          ))}
        </ol>
      </section>

      {/* Loading instructions by zone */}
      {zones.length > 0 && (
        <section className="trailer-detail__section">
          <h4 className="trailer-detail__section-title">Loading Instructions</h4>
          {zones.map((zone) => (
            <div key={zone.zone} className="trailer-detail__zone">
              <span className="trailer-detail__zone-name">{zone.zone}</span>
              <span className="trailer-detail__zone-text">{zone.text}</span>
            </div>
          ))}
        </section>
      )}

      {/* Plain-English explanation */}
      <section className="trailer-detail__section">
        <h4 className="trailer-detail__section-title">Why This Plan</h4>
        <p className="trailer-detail__explanation">{plan!.explanation}</p>
      </section>
    </div>
  );
}
