/**
 * DeliveryKpi (OUT-05, P2 / Phase 22) — live delivered-out count + on-time %.
 *
 * Surfaces the terminal-delivery KPI the operator cares about: how much freight
 * has EXITED the network (delivered) and what fraction met its SLA (on-time %).
 *
 * Data: `GET /api/delivery-kpi` → `{ deliveredCount, onTimeCount }` — the
 * event-derived counters (folded over the immutable event log, NOT a row-count
 * over the DELETE-purged package tables — D-22-3). Re-fetched on each ws envelope
 * (snapshot or tick) so the counters move as deliveries fire (same liveness
 * pattern as KpiDashboard).
 *
 * Pure helpers (unit-testable, no DOM):
 *  - `onTimePercent`: onTime / delivered as a rounded percent (0 when none).
 *  - `formatDeliveryKpi`: "X delivered (Y% on time)" summary string.
 *
 * Strict TS: no `any`, no `as`-casting of fixtures. React 19, pragmatic UI.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { useWsEnvelope } from "../map/WsProvider.js";
import { makeEntityMaps } from "../map/wsClient.js";
import { fetchDeliveryKpi } from "../api/client.js";
import type { DeliveryKpiDto } from "../api/client.js";
import type { EntityMaps } from "../map/wsClient.js";
import type { WsEnvelope } from "@mm/api";

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * On-time percentage = round(onTime / delivered * 100) ∈ [0, 100]. Zero
 * deliveries returns 0 (no division by zero), NOT a fabricated 100%.
 */
export function onTimePercent(delivered: number, onTime: number): number {
  if (delivered === 0) return 0;
  return Math.round((onTime / delivered) * 100);
}

/** Compact "{delivered} delivered ({pct}% on time)" summary. */
export function formatDeliveryKpi(delivered: number, onTime: number): string {
  return `${delivered} delivered (${onTimePercent(delivered, onTime)}% on time)`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type LoadState = "loading" | "error" | "loaded";

const ZERO_KPI: DeliveryKpiDto = { deliveredCount: 0, onTimeCount: 0 };

/**
 * DeliveryKpi — the OUT-05 delivered-out + on-time widget. Fetches the KPI on
 * mount and re-fetches on each ws envelope so the counters update live as
 * deliveries fire.
 */
export function DeliveryKpi(): React.JSX.Element {
  const [kpi, setKpi] = useState<DeliveryKpiDto>(ZERO_KPI);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const entityMapsRef = useRef<EntityMaps>(makeEntityMaps());
  const refetchAcRef = useRef<AbortController | null>(null);

  // --- Initial fetch --------------------------------------------------------
  useEffect(() => {
    const ac = new AbortController();
    setLoadState("loading");
    fetchDeliveryKpi(ac.signal)
      .then((next) => {
        setKpi(next);
        setLoadState("loaded");
      })
      .catch(() => {
        setLoadState("error");
      });
    return () => {
      ac.abort();
    };
  }, []);

  // --- ws-driven refetch ----------------------------------------------------
  // Each ws envelope (snapshot or tick) is a "sim advanced" signal — re-fetch the
  // authoritative counters so the panel moves as deliveries fire. Coalesce
  // overlapping refetches by aborting any in-flight request first.
  const onEnvelope = useCallback((envelope: WsEnvelope): void => {
    if (envelope.type !== "snapshot" && envelope.type !== "tick") return;
    refetchAcRef.current?.abort();
    const ac = new AbortController();
    refetchAcRef.current = ac;
    fetchDeliveryKpi(ac.signal)
      .then((next) => {
        setKpi(next);
        setLoadState("loaded");
      })
      .catch(() => {
        // Aborted or transient network error — keep the last good values.
      });
  }, []);

  useWsEnvelope(onEnvelope, entityMapsRef.current);

  useEffect(() => {
    return () => {
      refetchAcRef.current?.abort();
    };
  }, []);

  if (loadState === "loading") {
    return (
      <div className="delivery-kpi" data-testid="delivery-kpi-loading">
        <p className="delivery-kpi__loading">Loading deliveries…</p>
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <div className="delivery-kpi" data-testid="delivery-kpi-error">
        <p className="delivery-kpi__error">Failed to load delivery KPI.</p>
      </div>
    );
  }

  const { deliveredCount, onTimeCount } = kpi;
  const pct = onTimePercent(deliveredCount, onTimeCount);

  return (
    <div className="delivery-kpi" data-testid="delivery-kpi-loaded">
      <div className="delivery-kpi__header">
        <h3 className="delivery-kpi__title">Outbound Delivery</h3>
      </div>

      <div className="delivery-kpi__counts" role="group" aria-label="Delivered / on-time">
        <div className="delivery-kpi__count delivery-kpi__count--delivered">
          <span className="delivery-kpi__count-value" data-testid="delivery-kpi-delivered">
            {deliveredCount}
          </span>
          <span className="delivery-kpi__count-label">Delivered</span>
        </div>
        <div className="delivery-kpi__count delivery-kpi__count--ontime">
          <span className="delivery-kpi__count-value" data-testid="delivery-kpi-ontime-pct">
            {pct}%
          </span>
          <span className="delivery-kpi__count-label">On Time</span>
        </div>
      </div>

      <p className="delivery-kpi__summary" data-testid="delivery-kpi-summary">
        {formatDeliveryKpi(deliveredCount, onTimeCount)}
      </p>
    </div>
  );
}
