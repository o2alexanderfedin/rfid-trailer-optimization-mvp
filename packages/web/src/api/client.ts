import type { HubDto, RouteDto, KpiSnapshot, SimSpeedState } from "@mm/api";

export type { HubDto, RouteDto, KpiSnapshot, SimSpeedState };

// ---------------------------------------------------------------------------
// KPI comparison types (mirrors packages/api/src/kpis/comparison.ts — kept
// here so the web package doesn't import server-side modules directly).
// ---------------------------------------------------------------------------

/** Scores for one planner run (rehandle + utilization). */
export interface PlanScore {
  readonly rehandleScore: number;
  readonly utilizationScore: number;
}

/** Baseline-vs-optimizer comparison returned by `GET /api/kpis/comparison`. */
export interface KpiComparison {
  readonly baseline: PlanScore;
  readonly optimizer: PlanScore;
  readonly deltas: PlanScore;
}

// ---------------------------------------------------------------------------
// Wire DTOs for plan-detail endpoints (mirrors server types in plan-detail.ts,
// defined here to keep the web package free of a direct @mm/api server import).
// ---------------------------------------------------------------------------

/** One slice in the rear→nose order (depth 0 = rear). */
export interface RearToNoseSlice {
  readonly depth: number;
  readonly loadBlockIds: readonly string[];
}

/** One instruction zone entry from the Phase-2 instructions renderer. */
export interface ZoneInstruction {
  readonly zone: string;
  readonly blockIds: readonly string[];
  readonly text: string;
}

/** Loading instructions returned by `GET /trailers/:id/plan`. */
export interface LoadingInstructions {
  readonly trailerId: string;
  readonly zones: readonly ZoneInstruction[];
  readonly text: string;
}

/** Full plan detail DTO from `GET /api/trailers/:id/plan` (VIZ-05). */
export interface TrailerPlanDto {
  readonly trailerId: string;
  readonly rearToNose: readonly RearToNoseSlice[];
  readonly instructions: LoadingInstructions;
  readonly explanation: string;
}

/**
 * The assigned driver's live duty summary for a trailer at a hub (HUBQ-01).
 * Mirrors the server `HubTrailerDriverDto` in `packages/api/src/routes/hub-detail.ts`;
 * kept here so the web package never imports a server-side module directly.
 */
export interface HubTrailerDriverDto {
  readonly driverId: string;
  /** FMCSA duty status (`driving | on_break | resting | off_duty`). */
  readonly dutyStatus: string;
  /** Remaining legal drive minutes from the HOS clock (≥ 0). */
  readonly remainingDriveMinutes: number;
}

/** One trailer currently at a hub, fully described for the Hub Detail panel (HUBQ-01..07). */
export interface HubTrailerDto {
  readonly trailerId: string;
  /** Coarse operational state (`in_transit | arrived | docked`). */
  readonly status: string;
  /** The dock door the trailer is docked at; `null` when not docked. */
  readonly dockDoorId: string | null;
  readonly assignedPackageIds: readonly string[];
  /** The bound driver's duty summary; `null` when no driver is assigned. */
  readonly driver: HubTrailerDriverDto | null;
  /** HUBQ-03: rear→nose load plan (depth 0 = rear); `[]` when no plan derives. */
  readonly rearToNose: readonly RearToNoseSlice[];
  /** HUBQ-04: slice-aware utilization ratio in `[0, 1]`; `null` when no plan. */
  readonly utilization: number | null;
  /** HUBQ-06: the next destination hub; `null` when none derives. */
  readonly nextHubId: string | null;
  /** HUBQ-05: arrival sim-clock ms at THIS hub; `null` when no arrival on record. */
  readonly arrivedAtMs: number | null;
  /** HUBQ-07: ESTIMATED time-to-depart sim-clock ms for a parked trailer; `null` otherwise. */
  readonly estimatedEtaMs: number | null;
  /** HUBQ-07 honesty flag: `true` ⇒ `estimatedEtaMs` is an ESTIMATE, not a schedule. */
  readonly etaIsEstimate: boolean;
}

/**
 * FLOW-05 (P2): the hub's inbound/outbound inventory balance (cross-dock heat),
 * counts of the `hub_inventory` inbound/outbound buckets. Mirrors the server
 * `HubInventoryBalanceDto`.
 */
export interface HubInventoryBalanceDto {
  readonly inbound: number;
  readonly outbound: number;
}

/** The `GET /api/hubs/:id/detail` response (HUBQ-01..07 / VIZ-07..09 + FLOW-05 balance). */
export interface HubDetailDto {
  readonly hubId: string;
  /** Trailers at the hub, sorted by `trailerId` for a stable panel. */
  readonly trailers: readonly HubTrailerDto[];
  /** FLOW-05 (P2): inbound/outbound inventory balance (cross-dock heat). */
  readonly inventoryBalance: HubInventoryBalanceDto;
}

/** One entry from `GET /api/trailers/:id/history` or `GET /api/packages/:id/history` (UI-02). */
export interface TrailerHistoryEntryDto {
  readonly globalSeq: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly hubId: string | null;
  readonly scanType: string | null;
  readonly recommendation: string | null;
}

/**
 * Typed read-only fetch helpers for the map geo endpoints (Plan 06 contracts)
 * and plan-detail endpoints (Plan 04 contracts).
 *
 * All use the same-origin `/api` prefix — Vite proxies it to the Fastify
 * server in dev, and a reverse proxy does so in any deployment — so the web app
 * never hard-codes the API host (and the e2e can stub the boundary).
 */

/** `GET /api/hubs` -> all ~10 USA hubs (`{ hubId, name, lat, lon }`). */
export async function fetchHubs(
  signal?: AbortSignal,
): Promise<readonly HubDto[]> {
  const res = await fetch("/api/hubs", signal ? { signal } : {});
  if (!res.ok) {
    throw new Error(`GET /api/hubs failed: ${res.status}`);
  }
  return (await res.json()) as HubDto[];
}

/** `GET /api/routes` -> all linehaul routes with `[lon, lat][]` geometry. */
export async function fetchRoutes(
  signal?: AbortSignal,
): Promise<readonly RouteDto[]> {
  const res = await fetch("/api/routes", signal ? { signal } : {});
  if (!res.ok) {
    throw new Error(`GET /api/routes failed: ${res.status}`);
  }
  return (await res.json()) as RouteDto[];
}

/**
 * `GET /api/trailers/:id/plan` (VIZ-05) — rear→nose load plan with
 * loading instructions and a plain-English explanation.
 *
 * Returns null when the server responds 404 (no plan available yet,
 * trailer not found, or no assigned packages).
 */
export async function fetchTrailerPlan(
  trailerId: string,
  signal?: AbortSignal,
): Promise<TrailerPlanDto | null> {
  const res = await fetch(
    `/api/trailers/${encodeURIComponent(trailerId)}/plan`,
    signal ? { signal } : {},
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET /api/trailers/${trailerId}/plan failed: ${res.status}`);
  }
  return (await res.json()) as TrailerPlanDto;
}

/**
 * `GET /api/hubs/:id/detail` (HUBQ-01..07 / VIZ-07) — the trailers currently AT a
 * hub with per-trailer status, dock door, driver duty, load-plan summary,
 * utilization, next hub, arrival time, and an estimated ETA.
 *
 * An unseen / empty hub is a valid answer (`{ hubId, trailers: [] }`), never a
 * 404 — so this helper does not special-case a 404 the way `fetchTrailerPlan`
 * does. A non-2xx is a genuine error.
 */
export async function fetchHubDetail(
  hubId: string,
  signal?: AbortSignal,
): Promise<HubDetailDto> {
  const res = await fetch(
    `/api/hubs/${encodeURIComponent(hubId)}/detail`,
    signal ? { signal } : {},
  );
  if (!res.ok) {
    throw new Error(`GET /api/hubs/${hubId}/detail failed: ${res.status}`);
  }
  return (await res.json()) as HubDetailDto;
}

/**
 * `GET /api/trailers/:id/history` (UI-02) — read-only audit timeline
 * for a trailer including the captured system recommendation at each
 * plan-lifecycle event.
 *
 * Returns an empty array for an unknown trailer (absence = empty history).
 */
export async function fetchTrailerHistory(
  trailerId: string,
  signal?: AbortSignal,
): Promise<readonly TrailerHistoryEntryDto[]> {
  const res = await fetch(
    `/api/trailers/${encodeURIComponent(trailerId)}/history`,
    signal ? { signal } : {},
  );
  if (!res.ok) {
    throw new Error(
      `GET /api/trailers/${trailerId}/history failed: ${res.status}`,
    );
  }
  return (await res.json()) as TrailerHistoryEntryDto[];
}

/**
 * `GET /api/packages/:id/history` (UI-02) — read-only audit timeline
 * for a package including the captured system recommendation at each
 * decision event.
 *
 * Returns an empty array for an unknown package.
 */
export async function fetchPackageHistory(
  packageId: string,
  signal?: AbortSignal,
): Promise<readonly TrailerHistoryEntryDto[]> {
  const res = await fetch(
    `/api/packages/${encodeURIComponent(packageId)}/history`,
    signal ? { signal } : {},
  );
  if (!res.ok) {
    throw new Error(
      `GET /api/packages/${packageId}/history failed: ${res.status}`,
    );
  }
  return (await res.json()) as TrailerHistoryEntryDto[];
}

/**
 * `GET /api/kpis` (UI-03) — current live operational KPI snapshot.
 *
 * Returns `KpiSnapshot` including baseline sub-object (for the money slide).
 * The shape is identical to the ws tick `kpis` partial, so the dashboard
 * reads one shape from both REST and ws (single source of truth).
 */
export async function fetchKpis(signal?: AbortSignal): Promise<KpiSnapshot> {
  const res = await fetch("/api/kpis", signal ? { signal } : {});
  if (!res.ok) {
    throw new Error(`GET /api/kpis failed: ${res.status}`);
  }
  return (await res.json()) as KpiSnapshot;
}

/** `GET /api/delivery-kpi` (OUT-05 / D-22-3) — event-derived delivery counters. */
export interface DeliveryKpiDto {
  readonly deliveredCount: number;
  readonly onTimeCount: number;
}

/**
 * `GET /api/delivery-kpi` (OUT-05 P2 / D-22-3) — the delivered-out + on-time
 * counters for the operator panel `DeliveryKpi` widget. Event-derived (folded over
 * the immutable event log), NOT a row-count over the DELETE-purged package tables.
 */
export async function fetchDeliveryKpi(
  signal?: AbortSignal,
): Promise<DeliveryKpiDto> {
  const res = await fetch("/api/delivery-kpi", signal ? { signal } : {});
  if (!res.ok) {
    throw new Error(`GET /api/delivery-kpi failed: ${res.status}`);
  }
  return (await res.json()) as DeliveryKpiDto;
}

/**
 * `GET /api/kpis/comparison` (UI-04) — seed-deterministic baseline-vs-optimizer
 * comparison (the "money slide").
 *
 * Returns `KpiComparison` with `baseline`, `optimizer`, and `deltas` (each a
 * `PlanScore`). The comparison is computed on DEMO_SEED=42 and is byte-identical
 * across calls (KEYSTONE-b determinism contract).
 */
export async function fetchKpiComparison(
  signal?: AbortSignal,
): Promise<KpiComparison> {
  const res = await fetch("/api/kpis/comparison", signal ? { signal } : {});
  if (!res.ok) {
    throw new Error(`GET /api/kpis/comparison failed: ${res.status}`);
  }
  return (await res.json()) as KpiComparison;
}

/**
 * `POST /api/sim/speed` — set the global server-authoritative "speed of time".
 *
 * Body `{ multiplier?, paused? }`: `multiplier` is relative to the default 1×
 * (clamped server-side to [0.25, 8]); `paused` freezes the sim. Returns the
 * effective `SimSpeedState` the server applied. The server also pushes an
 * immediate ws envelope reflecting the change.
 */
export async function setSimSpeed(
  input: { multiplier?: number; paused?: boolean },
  signal?: AbortSignal,
): Promise<SimSpeedState> {
  const res = await fetch("/api/sim/speed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    throw new Error(`POST /api/sim/speed failed: ${res.status}`);
  }
  return (await res.json()) as SimSpeedState;
}
