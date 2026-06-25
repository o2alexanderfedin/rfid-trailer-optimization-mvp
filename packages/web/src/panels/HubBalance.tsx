/**
 * HubBalance (FLOW-05, P2) — per-hub inbound/outbound inventory balance.
 *
 * Surfaces the consolidation cross-dock value NUMERICALLY: how much freight flows
 * IN (inbound — arriving / consolidation legs) vs OUT (outbound — distribution
 * legs) at a hub. A center under active consolidation shows a high inbound count
 * balanced against its outbound — the cross-dock "heat".
 *
 * Data: `GET /api/hubs/:id/detail` → `inventoryBalance: { inbound, outbound }`
 * (the SAME `hub_inventory` projection the optimizer consumes — Decision 3).
 *
 * Pure helpers (unit-testable, no DOM):
 *  - `formatBalance`: "12 in / 8 out" summary string.
 *  - `crossDockRatio`: outbound / (inbound + outbound) ∈ [0, 1] (0 for an idle hub).
 *  - `heatClass`: "idle" | "cool" | "warm" | "hot" bucket from the throughput.
 *
 * Strict TS: no `any`, no `as`-casting of fixtures. React 19, pragmatic UI.
 */
import { useState, useEffect } from "react";
import { fetchHubDetail } from "../api/client.js";
import type { HubInventoryBalanceDto } from "../api/client.js";

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Compact "{inbound} in / {outbound} out" summary of the balance. */
export function formatBalance(inbound: number, outbound: number): string {
  return `${inbound} in / ${outbound} out`;
}

/**
 * Cross-dock ratio = outbound / (inbound + outbound) ∈ [0, 1]. An idle hub (no
 * freight either way) returns 0 (no division by zero). 1.0 ⇒ pure outflow,
 * 0.0 ⇒ pure inflow, ~0.5 ⇒ a balanced cross-dock.
 */
export function crossDockRatio(inbound: number, outbound: number): number {
  const total = inbound + outbound;
  if (total === 0) return 0;
  return outbound / total;
}

/**
 * Cross-dock heat bucket from TOTAL throughput (inbound + outbound) — a coarse
 * "how busy is this cross-dock" signal for the panel color. Deterministic
 * thresholds; an idle hub is its own bucket.
 */
export function heatClass(
  inbound: number,
  outbound: number,
): "idle" | "cool" | "warm" | "hot" {
  const total = inbound + outbound;
  if (total === 0) return "idle";
  if (total < 5) return "cool";
  if (total < 15) return "warm";
  return "hot";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type LoadState = "loading" | "error" | "loaded";

const ZERO_BALANCE: HubInventoryBalanceDto = { inbound: 0, outbound: 0 };

/** Props: the hub whose balance to display. */
export interface HubBalanceProps {
  readonly hubId: string;
}

/**
 * HubBalance — the FLOW-05 cross-dock heat widget. Fetches the hub-detail DTO on
 * mount (and when `hubId` changes) and renders the inbound/outbound balance
 * numerically with a heat-keyed accent.
 */
export function HubBalance({ hubId }: HubBalanceProps): React.JSX.Element {
  const [balance, setBalance] = useState<HubInventoryBalanceDto>(ZERO_BALANCE);
  const [loadState, setLoadState] = useState<LoadState>("loading");

  useEffect(() => {
    const ac = new AbortController();
    setLoadState("loading");
    fetchHubDetail(hubId, ac.signal)
      .then((detail) => {
        setBalance(detail.inventoryBalance);
        setLoadState("loaded");
      })
      .catch(() => {
        setLoadState("error");
      });
    return () => {
      ac.abort();
    };
  }, [hubId]);

  if (loadState === "loading") {
    return (
      <div className="hub-balance" data-testid="hub-balance">
        <p className="hub-balance__loading">Loading balance…</p>
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <div className="hub-balance" data-testid="hub-balance">
        <p className="hub-balance__error">Failed to load hub balance.</p>
      </div>
    );
  }

  const { inbound, outbound } = balance;
  const heat = heatClass(inbound, outbound);

  return (
    <div
      className={`hub-balance hub-balance--${heat}`}
      data-testid="hub-balance"
      data-heat={heat}
    >
      <div className="hub-balance__header">
        <h3 className="hub-balance__title">Cross-Dock Balance</h3>
        <p className="hub-balance__subtitle">Hub {hubId}</p>
      </div>

      <div className="hub-balance__counts" role="group" aria-label="Inbound / outbound balance">
        <div className="hub-balance__count hub-balance__count--inbound">
          <span className="hub-balance__count-value" data-testid="hub-balance-inbound">
            {inbound}
          </span>
          <span className="hub-balance__count-label">Inbound</span>
        </div>
        <div className="hub-balance__count hub-balance__count--outbound">
          <span className="hub-balance__count-value" data-testid="hub-balance-outbound">
            {outbound}
          </span>
          <span className="hub-balance__count-label">Outbound</span>
        </div>
      </div>

      <p className="hub-balance__summary" data-testid="hub-balance-summary">
        {formatBalance(inbound, outbound)}
      </p>
    </div>
  );
}
