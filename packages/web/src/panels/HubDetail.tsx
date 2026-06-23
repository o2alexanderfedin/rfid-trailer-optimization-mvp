/**
 * HubDetail (VIZ-07..11) — click-a-hub detail panel.
 *
 * When a hub is selected (via map click → `onHubSelect`), this panel:
 *  1. Fetches `GET /api/hubs/:id/detail` (HUBQ-01..07) via `fetchHubDetail`.
 *  2. Renders a COMPACT row per trailer at the hub (the user-approved layout):
 *       ▸ TRL-014  ⬤ docked   dwell 12m
 *          util 78% · 3 pkg · → ATL ~14m
 *          driver D003 ⬤ resting · 0m left
 *     i.e. operational status, LIVE elapsed dwell (`simMs − arrivedAtMs`, ticking
 *     via `useLiveSimMs`), utilization %, package count, next hub + ESTIMATED ETA
 *     (clearly marked with a leading ~), and the assigned driver's duty status +
 *     remaining legal drive minutes (the v1.2 hero datum — number AND duty bucket).
 *  3. VIZ-09: clicking a row opens the REUSED VIZ-05 `TrailerDetail` (full
 *     rear→nose plan + instructions + explanation) — not duplicated.
 *  4. VIZ-10: shows a per-row open-exceptions badge by filtering the already-
 *     streamed ws `exceptionsOpen` by `entityId === trailerId` (no extra fetch).
 *
 * Mirrors `TrailerDetail.tsx` (fetch-on-select + branchy render) and reuses the
 * existing visual language (the `trailer-detail` / row idioms). Pure formatters
 * are exported for Node unit tests.
 *
 * Threat parity with VIZ-05: all text via React's default escaping.
 */
import { useEffect, useState } from "react";
import {
  fetchHubDetail,
  type HubDetailDto,
  type HubTrailerDto,
} from "../api/client.js";
import { useLiveSimMs } from "../map/useLiveSimMs.js";
import { useOpenExceptions } from "./useOpenExceptions.js";
import { TrailerDetail } from "./TrailerDetail.js";

// ---------------------------------------------------------------------------
// Pure formatters (exported for Node unit tests)
// ---------------------------------------------------------------------------

const MS_PER_MINUTE = 60_000;

/** Whole-minute elapsed dwell `simMs − arrivedAtMs` (clamped ≥ 0); "—" if unknown. */
export function formatDwell(simMs: number, arrivedAtMs: number | null): string {
  if (arrivedAtMs === null) return "—";
  const mins = Math.max(0, Math.floor((simMs - arrivedAtMs) / MS_PER_MINUTE));
  return `${mins}m`;
}

/** Utilization ratio as a whole percent ("78%"); "—" when null (no plan). */
export function formatUtilPct(util: number | null): string {
  if (util === null) return "—";
  return `${Math.round(util * 100)}%`;
}

/**
 * Minutes-to-go to an ESTIMATED ETA, prefixed with `~` to mark the estimate
 * (HUBQ-07 honesty). "—" when no ETA is known. The `isEstimate` flag is honored
 * so an in-transit (non-estimate) value could be shown without the `~`.
 */
export function formatEtaEstimate(
  etaMs: number | null,
  simMs: number,
  isEstimate: boolean,
): string {
  if (etaMs === null) return "—";
  const mins = Math.max(0, Math.round((etaMs - simMs) / MS_PER_MINUTE));
  return `${isEstimate ? "~" : ""}${mins}m`;
}

/**
 * Map an FMCSA duty status to a small duty bucket (the same idea as the map's
 * driver-duty coloring): driving/on-duty = 0 (best), on_break = 1, resting = 2,
 * anything else (off_duty / unknown) = 3.
 */
export function dutyBucketFor(status: string): number {
  switch (status) {
    case "driving":
    case "on_duty":
      return 0;
    case "on_break":
      return 1;
    case "resting":
      return 2;
    default:
      return 3;
  }
}

/** Human label for a duty status ("on_break" → "on break"). */
export function dutyStatusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

/** Remaining legal drive minutes as "214m left". */
export function formatDriveMinutes(minutes: number): string {
  return `${Math.max(0, Math.round(minutes))}m left`;
}

// ---------------------------------------------------------------------------
// Fetch hook (mirrors useTrailerPlan)
// ---------------------------------------------------------------------------

interface HubFetchState {
  readonly detail: HubDetailDto | null;
  readonly loading: boolean;
  readonly error: string | null;
}

/**
 * Fetch the hub detail for `hubId` on change. Null + not-loading when `hubId` is
 * null. Aborts in-flight requests on id change / unmount (VIZ-05 discipline).
 */
export function useHubDetail(hubId: string | null): HubFetchState {
  const [state, setState] = useState<HubFetchState>({
    detail: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (hubId === null) {
      setState({ detail: null, loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setState({ detail: null, loading: true, error: null });

    void fetchHubDetail(hubId, controller.signal)
      .then((detail) => {
        if (!controller.signal.aborted) {
          setState({ detail, loading: false, error: null });
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          const msg = err instanceof Error ? err.message : "Failed to load hub";
          setState({ detail: null, loading: false, error: msg });
        }
      });

    return () => {
      controller.abort();
    };
  }, [hubId]);

  return state;
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface HubTrailerRowProps {
  readonly trailer: HubTrailerDto;
  readonly simMs: number;
  readonly exceptionCount: number;
  readonly onOpen: (trailerId: string) => void;
}

/** One compact trailer row (the approved VIZ-08 layout). */
function HubTrailerRow({
  trailer,
  simMs,
  exceptionCount,
  onOpen,
}: HubTrailerRowProps): React.JSX.Element {
  const { driver } = trailer;
  const dutyBucket = driver !== null ? dutyBucketFor(driver.dutyStatus) : 3;

  return (
    <li className="hub-detail__row" data-testid="hub-trailer-row">
      <button
        type="button"
        className="hub-detail__row-btn"
        onClick={() => onOpen(trailer.trailerId)}
        aria-label={`Open load plan for ${trailer.trailerId}`}
      >
        {/* Line 1: id · status · live dwell · exceptions */}
        <div className="hub-detail__row-top">
          <span className="hub-detail__trailer-id">{trailer.trailerId}</span>
          <span
            className="hub-detail__status"
            data-status={trailer.status}
          >
            {trailer.status.replace(/_/g, " ")}
          </span>
          <span className="hub-detail__dwell" data-testid="hub-trailer-dwell">
            dwell {formatDwell(simMs, trailer.arrivedAtMs)}
          </span>
          {exceptionCount > 0 && (
            <span
              className="hub-detail__exceptions"
              data-testid="hub-trailer-exceptions"
              title={`${exceptionCount} open exception${exceptionCount === 1 ? "" : "s"}`}
            >
              ⚠ {exceptionCount}
            </span>
          )}
        </div>

        {/* Line 2: util · pkg count · next hub + EST eta */}
        <div className="hub-detail__row-mid">
          <span>util {formatUtilPct(trailer.utilization)}</span>
          <span aria-hidden="true"> · </span>
          <span>{trailer.assignedPackageIds.length} pkg</span>
          <span aria-hidden="true"> · </span>
          <span>
            → {trailer.nextHubId ?? "—"}{" "}
            {formatEtaEstimate(trailer.estimatedEtaMs, simMs, trailer.etaIsEstimate)}
          </span>
        </div>

        {/* Line 3: the hero datum — driver duty + remaining legal drive minutes */}
        <div className="hub-detail__row-driver">
          {driver !== null ? (
            <span
              className="hub-detail__duty"
              data-testid="hub-trailer-duty"
              data-duty-bucket={dutyBucket}
            >
              driver {driver.driverId}{" "}
              <span className="hub-detail__duty-dot" aria-hidden="true">
                ⬤
              </span>{" "}
              {dutyStatusLabel(driver.dutyStatus)} ·{" "}
              {formatDriveMinutes(driver.remainingDriveMinutes)}
            </span>
          ) : (
            <span className="hub-detail__duty hub-detail__duty--none">
              no driver assigned
            </span>
          )}
        </div>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface HubDetailProps {
  /** The currently selected hub id, or null if nothing is selected. */
  readonly hubId: string | null;
}

/**
 * HubDetail panel — click a hub on the map to see the trailers AT it.
 *
 * Compact rows (VIZ-08), live dwell from ws `simMs` (VIZ-08), per-row exceptions
 * (VIZ-10), and a click-through to the reused VIZ-05 `TrailerDetail` (VIZ-09).
 */
export function HubDetail({ hubId }: HubDetailProps): React.JSX.Element {
  const { detail, loading, error } = useHubDetail(hubId);
  const simMs = useLiveSimMs();
  const lookupExceptions = useOpenExceptions();
  // The trailer whose full plan is being viewed via click-through (VIZ-09).
  const [openTrailerId, setOpenTrailerId] = useState<string | null>(null);

  // Reset the click-through whenever the selected hub changes.
  useEffect(() => {
    setOpenTrailerId(null);
  }, [hubId]);

  // Unselected state.
  if (hubId === null) {
    return (
      <div className="hub-detail" data-testid="hub-detail">
        <div className="hub-detail__prompt" data-testid="hub-detail-prompt">
          Click a hub on the map to view the trailers there.
        </div>
      </div>
    );
  }

  // Click-through: render the REUSED VIZ-05 TrailerDetail with a back affordance.
  if (openTrailerId !== null) {
    return (
      <div className="hub-detail" data-testid="hub-detail">
        <div className="hub-detail__header">
          <button
            type="button"
            className="hub-detail__back"
            data-testid="hub-detail-back"
            onClick={() => setOpenTrailerId(null)}
          >
            ← {hubId}
          </button>
          <span className="hub-detail__id">{openTrailerId}</span>
        </div>
        <TrailerDetail trailerId={openTrailerId} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="hub-detail" data-testid="hub-detail">
        <div className="hub-detail__loading">Loading hub {hubId}…</div>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="hub-detail" data-testid="hub-detail">
        <div className="hub-detail__error">Error: {error}</div>
      </div>
    );
  }

  const trailers = detail?.trailers ?? [];

  return (
    <div className="hub-detail" data-testid="hub-detail">
      <div className="hub-detail__header">
        <span className="hub-detail__id">Hub: {hubId}</span>
        <span className="hub-detail__count">
          {trailers.length} truck{trailers.length === 1 ? "" : "s"} here
        </span>
      </div>

      {trailers.length === 0 ? (
        <div className="hub-detail__empty" data-testid="hub-detail-empty">
          No trailers currently at this hub.
        </div>
      ) : (
        <>
          <div className="hub-detail__hint">click a row for the full load plan</div>
          <ul className="hub-detail__rows">
            {trailers.map((t) => (
              <HubTrailerRow
                key={t.trailerId}
                trailer={t}
                simMs={simMs}
                exceptionCount={lookupExceptions(t.trailerId).length}
                onOpen={setOpenTrailerId}
              />
            ))}
          </ul>
          <div className="hub-detail__footnote">
            ~ ETA is an estimate · status &amp; dwell are live
          </div>
        </>
      )}
    </div>
  );
}
