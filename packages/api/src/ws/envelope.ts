/**
 * Versioned ws envelope types (VIZ-04).
 *
 * Protocol contract for the demo's realtime channel:
 *   - `snapshot`: full baseline payload sent on connect/resync.
 *   - `tick`: per-sim-tick delta carrying ONLY changed fields (anti-pattern 4 /
 *     T-01-19 — never one message per raw domain event).
 *
 * Every envelope carries:
 *   - `v:1`   — protocol version for forward-compatible narrowing.
 *   - `seq`   — monotonic counter; a gap signals a dropped message (→ resync).
 *   - `simMs` — authoritative sim-clock milliseconds so the client can resync.
 *
 * Buckets for hub/route metrics are PRE-COMPUTED integers on the server
 * (P3-friendly: no float keys, O(1) style lookup by index on the client, Q4).
 */

// ---------------------------------------------------------------------------
// Sim-speed contract (shared by the backend SpeedController, the ws envelope,
// and the POST /api/sim/speed route)
// ---------------------------------------------------------------------------

/**
 * The effective "speed of time" state echoed on every ws envelope and returned
 * by `GET/POST /api/sim/speed`.
 *
 *  - `multiplier`     — speed relative to the default 1× (= 500 / tickIntervalMs).
 *  - `tickIntervalMs` — wall-clock ms the paced driver waits between sim ticks
 *                       (presentation pacing only — NEVER fed to the sim engine).
 *  - `simSpeed`       — the frontend clock's playback rate in sim-ms per wall-ms
 *                       (= MS_PER_TICK / tickIntervalMs), or **0 while paused** so
 *                       the trailer tween freezes.
 *  - `paused`         — whether the driver holds before advancing the next tick.
 */
export interface SimSpeedState {
  readonly multiplier: number;
  readonly tickIntervalMs: number;
  readonly simSpeed: number;
  readonly paused: boolean;
}

// ---------------------------------------------------------------------------
// Entity shapes
// ---------------------------------------------------------------------------

/** VIZ-02 — drives the client-side tween along the route LineString. */
export interface TrailerKeyframe {
  readonly id: string;
  /** RouteId → the LineString geometry already on the client (`/api/routes`). */
  readonly routeId: string;
  /** Sim-clock ms at leg start. */
  readonly departMs: number;
  /** Sim-clock ms at leg end (ETA). */
  readonly etaMs: number;
  /** Coloring driver. */
  readonly state: "onTime" | "slaRisk" | "late" | "idle";
  /** 0..1 fill ratio — optional, only when it changes (UI-02 hint). */
  readonly util?: number;
}

/**
 * SP2 (spec §8) — a MID-LEG truck STOP for the live map: the trailer parks at the
 * interpolated route position (`lon`/`lat`, computed server-side by the geo-track
 * projection) for `durationMinutes` starting at `startMs`. `kind` drives the
 * distinct parked/refueling marker style. ADDITIVE + OPTIONAL on the payload — a
 * client that predates it ignores it; an older server omits it.
 */
export interface TrailerStop {
  readonly trailerId: string;
  readonly tripId: string;
  readonly kind: "rested" | "refueling";
  readonly lon: number;
  readonly lat: number;
  /** Sim-clock ms the stop begins (the geo-track keyframe `t`). */
  readonly startMs: number;
  /** Whole minutes the trailer is parked here (the stop's dwell). */
  readonly durationMinutes: number;
}

/** VIZ-03 hub metrics (integer buckets for zero-allocation `StyleFunction`). */
export interface HubState {
  readonly id: string;
  readonly volumeBucket: number;
  readonly slaRiskBucket: number;
  readonly congestionBucket: number;
  /**
   * HUBQ-08 (v1.2) — small integer driver-duty buckets so the map can color hubs
   * by driver availability, derived from `driver_status` joined to the trailers
   * AT this hub. ADDITIVE + OPTIONAL: the envelope stays back-compatible (a v1
   * client that predates these fields simply ignores them; an older server that
   * omits them is read as 0 via `?? 0`). The production `buildSnapshotPayload`
   * always sets all three.
   *   - `driverCount`  — drivers currently assigned to trailers at the hub.
   *   - `onBreakCount` — of those, drivers in the 30-min `on_break` state.
   *   - `restingCount` — of those, drivers in the 10h/34h `resting` state.
   */
  readonly driverCount?: number;
  readonly onBreakCount?: number;
  readonly restingCount?: number;
}

/** VIZ-03 route/edge metrics. */
export interface RouteState {
  readonly id: string;
  readonly loadBucket: number;
  readonly slaRiskBucket: number;
}

/** VIZ-04 / UI-01 exception entry. */
export interface ExceptionItem {
  readonly id: string;
  readonly kind: "wrongTrailer" | "missedUnload" | "blockedFreight" | "lowUtilization";
  readonly severity: "low" | "med" | "high";
  /** trailerId / hubId / packageId the badge attaches to. */
  readonly entityId: string;
  /** Plain-English description. */
  readonly reason: string;
  readonly recommendedAction: string;
  /** Sim-clock ms when the exception was detected. */
  readonly simMs: number;
}

/** UI-04 — plan re-optimization made visible. */
export interface PlanDelta {
  readonly trailerId: string;
  readonly changeKind: "split" | "reassign" | "hold" | "overCarry" | "resequence";
  readonly rationale: string;
}

/** UI-03 / VIZ-05 "money slide" — baseline planner vs live optimizer. */
export interface KpiSnapshot {
  readonly utilization: number;
  readonly rehandleCount: number;
  readonly rehandleMinutes: number;
  readonly wrongTrailerCount: number;
  readonly missedUnloadCount: number;
  readonly slaViolationRate: number;
  /**
   * On-time departure rate in [0,1], or `null` when there is no schedule data to
   * measure against (F-03 / UI-03). The MVP persists no scheduled/planned
   * departure times (no event carries one — see `trailerDepartedSchema`), so a
   * 0/0 or no-data case is reported as `null` ("—" in the UI), NEVER a fabricated
   * 100%. A real ratio is returned only when actual on-time/total counts exist.
   */
  readonly onTimeDeparture: number | null;
  /** On-time arrival rate in [0,1], or `null` when there is no schedule data (F-03). */
  readonly onTimeArrival: number | null;
  /**
   * Baseline planner metrics over the SAME seeded stream.
   * Omit<KpiSnapshot,"baseline"> prevents recursive nesting.
   */
  readonly baseline: Omit<KpiSnapshot, "baseline">;
}

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

/** Full baseline — sent on connect / client-requested resync. */
export interface SnapshotPayload {
  readonly trailers: readonly TrailerKeyframe[];
  /**
   * SP2 (spec §8) — the mid-leg parked/refueling stops to render. OPTIONAL +
   * additive: an older server omits it (the client reads `?? []`), so the payload
   * stays back-compatible. The production builder always sets it (possibly empty).
   */
  readonly trailerStops?: readonly TrailerStop[];
  readonly hubs: readonly HubState[];
  readonly routes: readonly RouteState[];
  /**
   * F-02: live KPIs are served by `GET /api/kpis` (the single source of truth),
   * NOT over the ws channel. This field is optional and the production builder
   * omits it — a zeroed placeholder here would clobber the REST-fetched values
   * on the client. Kept optional (not removed) so `diffTick` can still compute a
   * KPI delta if a future plan ever decides to stream them.
   */
  readonly kpis?: KpiSnapshot;
  readonly exceptionsOpen: readonly ExceptionItem[];
}

/** Per-tick delta — only what changed since the prior tick. */
export interface TickPayload {
  /** Upsert: trailers whose leg/timing/state/util changed. */
  readonly trailers?: readonly TrailerKeyframe[];
  /** Delete: trailerIds that completed or left the network. */
  readonly trailersGone?: readonly string[];
  /**
   * SP2 (spec §8) — the FULL current set of mid-leg stops whenever it changed
   * (sent wholesale, not per-stop diffed: the set is tiny and a wholesale replace
   * keeps the client's parked-marker layer trivially consistent).
   */
  readonly trailerStops?: readonly TrailerStop[];
  /** Hubs whose metric bucket changed. */
  readonly hubs?: readonly HubState[];
  /** Routes whose metric bucket changed. */
  readonly routes?: readonly RouteState[];
  /** Changed KPI fields only (Partial avoids sending the whole snapshot). */
  readonly kpis?: Partial<KpiSnapshot>;
  /** New exceptions opened this tick. */
  readonly exceptionsNew?: readonly ExceptionItem[];
  /** Exception ids cleared this tick. */
  readonly exceptionsResolved?: readonly string[];
  /** Plan deltas from a re-optimization event. */
  readonly planChanges?: readonly PlanDelta[];
}

// ---------------------------------------------------------------------------
// Versioned envelope union
// ---------------------------------------------------------------------------

/**
 * Wire envelope. `v` = protocol version for evolution-safe narrowing.
 *
 * `speed` is an envelope-level field (beside `simMs`, NOT inside `payload`), so
 * the client can drive its local tween clock at the server's effective rate and
 * `diffTick` (which only operates on payloads) is untouched.
 */
export type WsEnvelope =
  | { readonly v: 1; readonly type: "snapshot"; readonly seq: number; readonly simMs: number; readonly speed: SimSpeedState; readonly payload: SnapshotPayload }
  | { readonly v: 1; readonly type: "tick";     readonly seq: number; readonly simMs: number; readonly speed: SimSpeedState; readonly payload: TickPayload };

// ---------------------------------------------------------------------------
// diffTick: pure delta builder (data-in / data-out, no I/O, unit-testable)
// ---------------------------------------------------------------------------

type KpiKey = Exclude<keyof KpiSnapshot, "baseline">;

const KPI_KEYS: readonly KpiKey[] = [
  "utilization",
  "rehandleCount",
  "rehandleMinutes",
  "wrongTrailerCount",
  "missedUnloadCount",
  "slaViolationRate",
  "onTimeDeparture",
  "onTimeArrival",
];

/** Stable string comparator for id-sorted output (P3 determinism). */
function byId(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True iff two `TrailerKeyframe`s differ in any field. */
function trailerChanged(prev: TrailerKeyframe, next: TrailerKeyframe): boolean {
  return (
    prev.routeId !== next.routeId ||
    prev.departMs !== next.departMs ||
    prev.etaMs !== next.etaMs ||
    prev.state !== next.state ||
    prev.util !== next.util
  );
}

/** True iff two `HubState`s differ in any bucket (incl. HUBQ-08 driver buckets). */
function hubChanged(prev: HubState, next: HubState): boolean {
  return (
    prev.volumeBucket !== next.volumeBucket ||
    prev.slaRiskBucket !== next.slaRiskBucket ||
    prev.congestionBucket !== next.congestionBucket ||
    // Optional driver buckets: treat absent as 0 so a back-compat payload that
    // never sets them produces no spurious delta.
    (prev.driverCount ?? 0) !== (next.driverCount ?? 0) ||
    (prev.onBreakCount ?? 0) !== (next.onBreakCount ?? 0) ||
    (prev.restingCount ?? 0) !== (next.restingCount ?? 0)
  );
}

/** True iff two `RouteState`s differ in any bucket. */
function routeChanged(prev: RouteState, next: RouteState): boolean {
  return prev.loadBucket !== next.loadBucket || prev.slaRiskBucket !== next.slaRiskBucket;
}

/**
 * Compute a `TickPayload` containing ONLY the entities that changed between
 * `prev` and `next`. Collections are sorted by id for P3 determinism.
 * Returns an empty object `{}` when nothing changed (zero-noise ticks).
 *
 * Pure: no I/O, no `Date.now()`, no side effects — safe to unit-test.
 */
export function diffTick(prev: SnapshotPayload, next: SnapshotPayload): TickPayload {
  const result: {
    trailers?: TrailerKeyframe[];
    trailersGone?: string[];
    trailerStops?: TrailerStop[];
    hubs?: HubState[];
    routes?: RouteState[];
    kpis?: Partial<KpiSnapshot>;
    exceptionsNew?: ExceptionItem[];
    exceptionsResolved?: string[];
    planChanges?: PlanDelta[];
  } = {};

  // --- Trailers: upsert (changed or new) + delete (gone) -------------------
  const prevTrailers = new Map<string, TrailerKeyframe>(prev.trailers.map((t) => [t.id, t]));
  const nextTrailers = new Map<string, TrailerKeyframe>(next.trailers.map((t) => [t.id, t]));

  const upserted: TrailerKeyframe[] = [];
  for (const [id, nxt] of nextTrailers) {
    const prv = prevTrailers.get(id);
    if (prv === undefined || trailerChanged(prv, nxt)) {
      upserted.push(nxt);
    }
  }
  upserted.sort(byId);
  if (upserted.length > 0) result.trailers = upserted;

  const gone: string[] = [];
  for (const id of prevTrailers.keys()) {
    if (!nextTrailers.has(id)) gone.push(id);
  }
  gone.sort(byString);
  if (gone.length > 0) result.trailersGone = gone;

  // --- SP2 trailer stops: wholesale replace when the set changed --------------
  // The set is tiny (only in-flight stops) so a full replace on any change keeps
  // the client's parked-marker layer trivially consistent (no per-stop diff/key).
  const prevStops = prev.trailerStops ?? [];
  const nextStops = next.trailerStops ?? [];
  if (JSON.stringify(prevStops) !== JSON.stringify(nextStops)) {
    result.trailerStops = [...nextStops];
  }

  // --- Hubs: upsert (bucket changed or new) --------------------------------
  const prevHubs = new Map<string, HubState>(prev.hubs.map((h) => [h.id, h]));
  const changedHubs: HubState[] = [];
  for (const nxt of next.hubs) {
    const prv = prevHubs.get(nxt.id);
    if (prv === undefined || hubChanged(prv, nxt)) {
      changedHubs.push(nxt);
    }
  }
  changedHubs.sort(byId);
  if (changedHubs.length > 0) result.hubs = changedHubs;

  // --- Routes: upsert (bucket changed or new) ------------------------------
  const prevRoutes = new Map<string, RouteState>(prev.routes.map((r) => [r.id, r]));
  const changedRoutes: RouteState[] = [];
  for (const nxt of next.routes) {
    const prv = prevRoutes.get(nxt.id);
    if (prv === undefined || routeChanged(prv, nxt)) {
      changedRoutes.push(nxt);
    }
  }
  changedRoutes.sort(byId);
  if (changedRoutes.length > 0) result.routes = changedRoutes;

  // --- Exceptions: new + resolved ------------------------------------------
  const prevExIds = new Set<string>(prev.exceptionsOpen.map((e) => e.id));
  const nextExIds = new Set<string>(next.exceptionsOpen.map((e) => e.id));

  const newExceptions: ExceptionItem[] = [];
  for (const ex of next.exceptionsOpen) {
    if (!prevExIds.has(ex.id)) newExceptions.push(ex);
  }
  newExceptions.sort(byId);
  if (newExceptions.length > 0) result.exceptionsNew = newExceptions;

  const resolved: string[] = [];
  for (const id of prevExIds) {
    if (!nextExIds.has(id)) resolved.push(id);
  }
  resolved.sort(byString);
  if (resolved.length > 0) result.exceptionsResolved = resolved;

  // --- KPIs: partial diff (only changed numeric fields) --------------------
  // F-02: the ws channel normally omits `kpis` (live KPIs come from GET /api/kpis).
  // Only compute a delta when BOTH sides carry KPIs; otherwise emit nothing.
  const prevKpis = prev.kpis;
  const nextKpis = next.kpis;
  if (prevKpis !== undefined && nextKpis !== undefined) {
    const kpiDiff: Partial<KpiSnapshot> = {};
    let kpiChanged = false;
    for (const key of KPI_KEYS) {
      if (prevKpis[key] !== nextKpis[key]) {
        // Cast needed: TS can't narrow `Partial<KpiSnapshot>[key]` from the loop.
        (kpiDiff as Record<string, unknown>)[key] = nextKpis[key];
        kpiChanged = true;
      }
    }
    if (kpiChanged) result.kpis = kpiDiff;
  }

  return result;
}
