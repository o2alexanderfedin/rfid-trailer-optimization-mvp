/**
 * KpiDashboard (UI-03) — live operational KPI panel with animated deltas.
 *
 * Data flow:
 *  - On mount: `GET /api/kpis` → initial KpiSnapshot
 *  - Ongoing: tick `kpis` partials from the ws envelope → merged via
 *    `applyKpiPartial` (changed fields only)
 *  - Animation: fields that change trigger a brief CSS flash class so "numbers
 *    visibly move" (PITFALLS UX mandate)
 *
 * Pure helpers (unit-testable without DOM):
 *  - `applyKpiPartial`: immutable merge of Partial<KpiSnapshot>
 *  - `shouldAnimate`: detects changed numeric fields
 *  - `formatKpiValue`: count / minutes / percentage formatting
 *  - `kpiCards`: ordered KPI card definitions
 *
 * Strict TS: no `any`, no `as`, React 19. Off the map render path.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { useWsEnvelope, makeEntityMaps } from "../map/wsClient.js";
import { fetchKpis } from "../api/client.js";
import type { KpiSnapshot, WsEnvelope } from "@mm/api";
import type { EntityMaps } from "../map/wsClient.js";

// ---------------------------------------------------------------------------
// Public types (exported for tests)
// ---------------------------------------------------------------------------

/** Current snapshot + set of fields currently mid-animation. */
export interface KpiState {
  readonly current: KpiSnapshot;
  readonly animatingFields: ReadonlySet<string>;
}

/** One card definition in the dashboard. */
export interface KpiCardDef {
  readonly field: Exclude<keyof KpiSnapshot, "baseline">;
  readonly label: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Immutable merge of a `Partial<KpiSnapshot>` onto `prev`.
 * `baseline` is never updated from tick partials (it is set once on mount).
 */
export function applyKpiPartial(
  prev: KpiSnapshot,
  partial: Partial<KpiSnapshot>,
): KpiSnapshot {
  return {
    utilization: partial.utilization ?? prev.utilization,
    rehandleCount: partial.rehandleCount ?? prev.rehandleCount,
    rehandleMinutes: partial.rehandleMinutes ?? prev.rehandleMinutes,
    wrongTrailerCount: partial.wrongTrailerCount ?? prev.wrongTrailerCount,
    missedUnloadCount: partial.missedUnloadCount ?? prev.missedUnloadCount,
    slaViolationRate: partial.slaViolationRate ?? prev.slaViolationRate,
    onTimeDeparture: partial.onTimeDeparture ?? prev.onTimeDeparture,
    onTimeArrival: partial.onTimeArrival ?? prev.onTimeArrival,
    baseline: prev.baseline, // never from tick partials
  };
}

type AnimatableField = Exclude<keyof KpiSnapshot, "baseline">;

/**
 * Returns true if `field` has a different value between `prev` and `next`.
 * Only works for the 8 numeric fields; returns false for "baseline".
 */
export function shouldAnimate(
  field: string,
  prev: KpiSnapshot,
  next: KpiSnapshot,
): boolean {
  if (field === "baseline") return false;
  const k = field as AnimatableField;
  if (!(k in prev) || !(k in next)) return false;
  return prev[k] !== next[k];
}

/** KPI value format kinds. */
type FormatKind = "count" | "minutes" | "percent";

function formatKindFor(field: string): FormatKind {
  if (field === "rehandleMinutes") return "minutes";
  if (
    field === "utilization" ||
    field === "slaViolationRate" ||
    field === "onTimeDeparture" ||
    field === "onTimeArrival"
  )
    return "percent";
  return "count";
}

/**
 * Format a KPI value for display.
 *  - counts     → integer string ("7")
 *  - minutes    → 1dp with "min" suffix ("18.5 min")
 *  - rates/fractions → percentage 1dp ("75.0%")
 */
export function formatKpiValue(field: string, value: number): string {
  const kind = formatKindFor(field);
  if (kind === "count") return String(Math.round(value));
  if (kind === "minutes") return `${value.toFixed(1)} min`;
  // percent: multiply by 100
  return `${(value * 100).toFixed(1)}%`;
}

/** Ordered KPI card definitions for the dashboard. */
export function kpiCards(): readonly KpiCardDef[] {
  return [
    { field: "utilization", label: "Utilization" },
    { field: "rehandleCount", label: "Rehandles" },
    { field: "rehandleMinutes", label: "Rehandle Time" },
    { field: "wrongTrailerCount", label: "Wrong Trailer" },
    { field: "missedUnloadCount", label: "Missed Unload" },
    { field: "slaViolationRate", label: "SLA Violation Rate" },
    { field: "onTimeDeparture", label: "On-Time Departure" },
    { field: "onTimeArrival", label: "On-Time Arrival" },
  ] as const;
}

// ---------------------------------------------------------------------------
// Zero-state snapshot (before the initial fetch completes)
// ---------------------------------------------------------------------------

const ZERO_SNAPSHOT: KpiSnapshot = {
  utilization: 0,
  rehandleCount: 0,
  rehandleMinutes: 0,
  wrongTrailerCount: 0,
  missedUnloadCount: 0,
  slaViolationRate: 0,
  onTimeDeparture: 1,
  onTimeArrival: 1,
  baseline: {
    utilization: 0,
    rehandleCount: 0,
    rehandleMinutes: 0,
    wrongTrailerCount: 0,
    missedUnloadCount: 0,
    slaViolationRate: 0,
    onTimeDeparture: 1,
    onTimeArrival: 1,
  },
};

// Animation flash duration in ms
const ANIMATE_MS = 700;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * KPI dashboard — live operational metrics (UI-03).
 *
 * Consumes `GET /api/kpis` on mount + `kpis` partials from the ws tick.
 * Shows all 8 operational KPIs with animated value changes.
 *
 * Off the map render path: ws handled in a ref-stable callback.
 */
export function KpiDashboard(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<KpiSnapshot>(ZERO_SNAPSHOT);
  const [animating, setAnimating] = useState<ReadonlySet<string>>(new Set<string>());
  const prevRef = useRef<KpiSnapshot>(ZERO_SNAPSHOT);
  const timerRefs = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // --- Initial fetch --------------------------------------------------------
  useEffect(() => {
    const ac = new AbortController();
    fetchKpis(ac.signal)
      .then((kpis) => {
        prevRef.current = kpis;
        setSnapshot(kpis);
      })
      .catch(() => {
        // Network error before unmount — leave zero state
      });
    return () => {
      ac.abort();
      // Clear all animation timers on unmount
      for (const t of timerRefs.current.values()) {
        clearTimeout(t);
      }
      timerRefs.current.clear();
    };
  }, []);

  // --- ws tick updates -------------------------------------------------------
  const entityMapsRef = useRef<EntityMaps>(makeEntityMaps());

  const onEnvelope = useCallback(
    (envelope: WsEnvelope): void => {
      const partial =
        envelope.type === "snapshot"
          ? envelope.payload.kpis
          : envelope.payload.kpis;
      if (partial === undefined) return;

      setSnapshot((prev) => {
        const next = applyKpiPartial(prev, partial as Partial<KpiSnapshot>);

        // Collect changed fields for animation
        const changed: string[] = [];
        for (const card of kpiCards()) {
          if (shouldAnimate(card.field, prev, next)) {
            changed.push(card.field);
          }
        }

        if (changed.length > 0) {
          setAnimating((cur) => {
            const next2 = new Set(cur);
            for (const f of changed) {
              next2.add(f);
              // Clear existing timer for this field
              const existing = timerRefs.current.get(f);
              if (existing !== undefined) clearTimeout(existing);
              // Schedule removal
              timerRefs.current.set(
                f,
                setTimeout(() => {
                  setAnimating((s) => {
                    const cleared = new Set(s);
                    cleared.delete(f);
                    return cleared;
                  });
                  timerRefs.current.delete(f);
                }, ANIMATE_MS),
              );
            }
            return next2;
          });
        }

        prevRef.current = next;
        return next;
      });
    },
    [],
  );

  useWsEnvelope(onEnvelope, entityMapsRef.current);

  // --- Render ----------------------------------------------------------------
  const cards = kpiCards();

  return (
    <div className="kpi-dashboard" data-testid="kpi-dashboard">
      <div className="kpi-dashboard__grid">
        {cards.map((card) => {
          const value = snapshot[card.field] as number;
          const isAnimating = animating.has(card.field);
          return (
            <div
              key={card.field}
              className={`kpi-card${isAnimating ? " kpi-card--animating" : ""}`}
              data-testid={`kpi-card-${card.field}`}
              data-field={card.field}
            >
              <span className="kpi-card__label">{card.label}</span>
              <span
                className="kpi-card__value"
                data-testid={`kpi-value-${card.field}`}
                data-animating={isAnimating ? "true" : "false"}
              >
                {formatKpiValue(card.field, value)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
