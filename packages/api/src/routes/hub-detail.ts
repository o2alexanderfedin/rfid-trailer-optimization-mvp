import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Hub, TimingConfig } from "@mm/domain";
import {
  DEFAULT_TIMING_CONFIG,
  expectedDwellMinutes,
  expectedTransitMinutes,
} from "@mm/domain";
import { type ApiDb, readHubsFromLog } from "./queries.js";
import {
  reconstructTrailerPlan,
  readHubOutboundIndex,
  readRouteDestHubs,
  type RearToNoseSlice,
} from "./load-plan-helper.js";

/**
 * `GET /hubs/:id/detail` (v1.2 HUBQ-01..07).
 *
 * The single read endpoint backing the Phase-17 Hub Detail panel: everything
 * about the trailers CURRENTLY AT a hub that the ws channel does not carry. It is
 * a pure read over existing projections + the immutable log — no sim/optimizer
 * behavior, no writes (mirrors `queries.ts` / `plan-detail.ts`).
 *
 * For each trailer where `trailer_state.current_hub_id = :id` it returns:
 *  - HUBQ-01: `status`, `dockDoorId`, `assignedPackageIds`, and — joining
 *    `trailer_state.driver_id → driver_status` — the assigned driver's duty
 *    status + remaining legal drive minutes (`null` when no driver is bound).
 *  - HUBQ-02: the `WHERE current_hub_id = :id` filter is served by the
 *    `idx_trailer_state_current_hub` btree index (no full-table scan per click).
 *  - HUBQ-03/04/06: a per-trailer load-plan summary via the SHARED
 *    `reconstructTrailerPlan` helper (the exact `/trailers/:id/plan` pipeline),
 *    carrying the rear→nose order, the slice-aware utilization ratio, and the
 *    derived `nextHubId`.
 *  - HUBQ-05: `arrivedAtMs` from the most recent `TrailerArrivedAtHub` for
 *    `(trailer_id, hub_id)` in `audit_timeline` (ORDER BY global_seq DESC LIMIT 1)
 *    — NOT `trailer_state.last_event_at` (which advances on later events and would
 *    under-report dwell). The client ticks live elapsed dwell against ws `simMs`.
 *  - HUBQ-07: an EXPLICITLY ESTIMATED time-to-depart for parked trailers =
 *    `arrivedAtMs + expected dwell (hub role) + expected transit (next leg)`. For
 *    in-transit trailers no server estimate is fabricated (the ws `etaMs` covers
 *    them) — `estimatedEtaMs` is `null` and `etaIsEstimate` is `false`.
 *
 * An unseen hub is a valid empty answer (`{ hubId, trailers: [] }`), never a 404.
 */

// ---------------------------------------------------------------------------
// Wire DTOs (the public, stable hub-detail shape — distinct from ws HubState)
// ---------------------------------------------------------------------------

/** The assigned driver's live duty summary for a trailer at the hub (HUBQ-01). */
export interface HubTrailerDriverDto {
  readonly driverId: string;
  /** FMCSA duty status (`driving | on_break | resting | off_duty`). */
  readonly dutyStatus: string;
  /** Remaining legal drive minutes from the HOS clock (≥ 0). */
  readonly remainingDriveMinutes: number;
}

/** One trailer currently at the hub, fully described for the panel. */
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
  /**
   * HUBQ-05: arrival sim-clock ms at THIS hub (most recent `TrailerArrivedAtHub`),
   * `null` when no arrival is on record (e.g. a trailer seeded directly at a hub).
   */
  readonly arrivedAtMs: number | null;
  /**
   * HUBQ-07: ESTIMATED time-to-depart sim-clock ms for a parked trailer
   * (`arrivedAtMs + expected dwell + expected transit`). `null` for in-transit
   * trailers (use the ws `etaMs`) or when `arrivedAtMs`/`nextHubId` is unknown.
   */
  readonly estimatedEtaMs: number | null;
  /** HUBQ-07 honesty flag: `true` ⇒ `estimatedEtaMs` is an ESTIMATE, not a schedule. */
  readonly etaIsEstimate: boolean;
}

/**
 * FLOW-05 (P2): the hub's inbound/outbound inventory balance — the cross-dock
 * "heat" of consolidation. Counts (not ids) of the `hub_inventory` projection's
 * `inbound`/`outbound` buckets (the SAME projection the optimizer consumes —
 * Decision 3). A center under active consolidation shows inbound from
 * consolidation legs balanced against outbound to distribution legs.
 */
export interface HubInventoryBalanceDto {
  /** Number of packages currently inbound at this hub (arriving freight). */
  readonly inbound: number;
  /** Number of packages currently outbound at this hub (departing freight). */
  readonly outbound: number;
}

/** The `GET /hubs/:id/detail` response (HUBQ-01..07 + FLOW-05 balance). */
export interface HubDetailDto {
  readonly hubId: string;
  /** Trailers at the hub, sorted by `trailerId` for a stable panel (P3). */
  readonly trailers: readonly HubTrailerDto[];
  /**
   * FLOW-05 (P2): inbound/outbound inventory balance (cross-dock heat) from
   * `hub_inventory`. A zero balance for an unseen hub or a hub with no
   * inventory row (a valid empty answer, never a throw).
   */
  readonly inventoryBalance: HubInventoryBalanceDto;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const idParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1 } },
} as const;

interface IdParams {
  readonly id: string;
}

/** 1 sim tick = 1 minute (project-wide); the geo/timing math is in MINUTES. */
const MS_PER_MINUTE = 60_000;

/** Coerce a JSONB timestamptz column to epoch ms (the `pg` driver yields a Date). */
function toMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * HUBQ-05 — the arrival sim-ms at `hubId`: the `occurred_at` of the MOST RECENT
 * `TrailerArrivedAtHub` row for `(trailer_id, hub_id)` in `audit_timeline`
 * (ORDER BY global_seq DESC LIMIT 1). `null` when no such row exists. Uses the
 * `(trailer_id, global_seq)` index. Deliberately NOT `trailer_state.last_event_at`.
 */
async function readArrivedAtMs(
  db: ApiDb,
  trailerId: string,
  hubId: string,
): Promise<number | null> {
  const row = await db
    .selectFrom("audit_timeline")
    .select(["occurred_at"])
    .where("trailer_id", "=", trailerId)
    .where("hub_id", "=", hubId)
    .where("event_type", "=", "TrailerArrivedAtHub")
    .orderBy("global_seq", "desc")
    .limit(1)
    .executeTakeFirst();
  return row === undefined ? null : toMs(row.occurred_at);
}

/**
 * FLOW-05 (P2) — the hub's inbound/outbound inventory balance: the COUNTS of the
 * `hub_inventory.inbound`/`outbound` JSONB buckets for `hubId`. A hub with no
 * inventory row (unseen or never-touched) yields a zero balance (no throw) — the
 * established hub-detail valid-empty discipline. Parameterized read, no full scan.
 */
async function readInventoryBalance(
  db: ApiDb,
  hubId: string,
): Promise<HubInventoryBalanceDto> {
  const row = await db
    .selectFrom("hub_inventory")
    .select(["inbound", "outbound"])
    .where("hub_id", "=", hubId)
    .executeTakeFirst();
  if (row === undefined) return { inbound: 0, outbound: 0 };
  return { inbound: row.inbound.length, outbound: row.outbound.length };
}

/**
 * Derive the hub-and-spoke CENTER hub from the `RouteRegistered` legs: the hub on
 * the most legs (degree). Used to pick the dwell role for the ETA estimate. Stable
 * id-ascending tie-break (anti-P3). Mirrors `twin-snapshot.ts:deriveCenterHub`.
 */
function deriveCenterHubId(
  legs: readonly { fromHubId: string; toHubId: string }[],
  sortedHubIds: readonly string[],
): string | undefined {
  if (sortedHubIds.length === 0) return undefined;
  const degree = new Map<string, number>();
  for (const leg of legs) {
    degree.set(leg.fromHubId, (degree.get(leg.fromHubId) ?? 0) + 1);
    degree.set(leg.toHubId, (degree.get(leg.toHubId) ?? 0) + 1);
  }
  let best = sortedHubIds[0]!;
  let bestDegree = degree.get(best) ?? 0;
  for (const hubId of sortedHubIds) {
    const d = degree.get(hubId) ?? 0;
    if (d > bestDegree) {
      best = hubId;
      bestDegree = d;
    }
  }
  return best;
}

/**
 * HUBQ-07 — the ESTIMATED depart sim-ms for a parked trailer:
 * `arrivedAtMs + expected dwell(this hub's role) + expected transit(this hub →
 * nextHub)`, in ms. Pure: a function of the timestamps, hub coordinates, and
 * config. Returns `null` when the inputs needed to estimate are absent.
 */
function estimateDepartMs(opts: {
  readonly arrivedAtMs: number | null;
  readonly currentHub: Hub | undefined;
  readonly nextHub: Hub | undefined;
  readonly isCenter: boolean;
  readonly config: TimingConfig;
}): number | null {
  const { arrivedAtMs, currentHub, nextHub, isCenter, config } = opts;
  if (arrivedAtMs === null || currentHub === undefined || nextHub === undefined) {
    return null;
  }
  const dwellMin = expectedDwellMinutes(isCenter ? "center" : "spoke", config);
  const transitMin = expectedTransitMinutes(currentHub, nextHub, config);
  return arrivedAtMs + (dwellMin + transitMin) * MS_PER_MINUTE;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register `GET /hubs/:id/detail` (HUBQ-01..07) on `app`. `db` is the
 * composition-root handle. `timing` is injectable for deterministic tests; it
 * defaults to {@link DEFAULT_TIMING_CONFIG} (the same distributions the sim draws).
 */
export function registerHubDetailRoutes(
  app: FastifyInstance,
  db: ApiDb,
  timing: TimingConfig = DEFAULT_TIMING_CONFIG,
): void {
  app.get<{ Params: IdParams }>(
    "/hubs/:id/detail",
    { schema: { params: idParamsSchema } },
    async (req: FastifyRequest<{ Params: IdParams }>): Promise<HubDetailDto> => {
      const hubId = req.params.id;

      // HUBQ-01/02: the trailers AT this hub (index-backed reverse lookup), the
      // shared reconstruction inputs, the route legs, and the hub geo — read in
      // parallel (each is an independent read).
      const [
        trailerRows,
        hubOutboundIndex,
        routeDestHubs,
        routeLegs,
        hubs,
        inventoryBalance,
      ] = await Promise.all([
        db
          .selectFrom("trailer_state")
          .selectAll()
          .where("current_hub_id", "=", hubId)
          .execute(),
        readHubOutboundIndex(db),
        readRouteDestHubs(db, hubId),
        db
          .selectFrom("events")
          .select(["data"])
          .where("event_type", "=", "RouteRegistered")
          .orderBy("global_seq", "asc")
          .execute(),
        readHubsFromLog(db),
        // FLOW-05 (P2): inbound/outbound balance read alongside the rest.
        readInventoryBalance(db, hubId),
      ]);

      if (trailerRows.length === 0) {
        // Valid empty answer for an unseen / empty hub (not a 404). The balance
        // still reports the hub's inventory (a center can hold freight with no
        // trailer currently docked).
        return { hubId, trailers: [], inventoryBalance };
      }

      const hubById = new Map<string, Hub>(hubs.map((h) => [h.hubId, h]));
      const sortedHubIds = [...hubById.keys()].sort();
      const legs = routeLegs.map((r) => r.data as { fromHubId: string; toHubId: string });
      const centerHubId = deriveCenterHubId(legs, sortedHubIds);
      const currentHub = hubById.get(hubId);

      // HUBQ-01: join the bound drivers in ONE query (driver_id → driver_status).
      const driverIds = [
        ...new Set(
          trailerRows
            .map((t) => t.driver_id)
            .filter((d): d is string => d !== null && d.length > 0),
        ),
      ];
      const driverRows =
        driverIds.length === 0
          ? []
          : await db
              .selectFrom("driver_status")
              .select(["driver_id", "status", "remaining_drive_minutes"])
              .where("driver_id", "in", driverIds)
              .execute();
      const driverById = new Map(driverRows.map((d) => [d.driver_id, d]));

      // Per-trailer assembly (HUBQ-03..07). arrivedAtMs is one indexed query per
      // trailer; the rest is pure in-memory reconstruction over the shared inputs.
      const trailers: HubTrailerDto[] = await Promise.all(
        trailerRows.map(async (t): Promise<HubTrailerDto> => {
          const plan = reconstructTrailerPlan(
            t.assigned_package_ids,
            hubOutboundIndex,
            routeDestHubs,
          );

          const arrivedAtMs = await readArrivedAtMs(db, t.trailer_id, hubId);
          const nextHubId = plan?.nextHubId ?? null;
          const nextHub = nextHubId !== null ? hubById.get(nextHubId) : undefined;

          // HUBQ-07: estimate only for PARKED trailers (not in_transit) and only
          // when an onward hop + arrival time exist; otherwise null + not-estimate.
          const isParked = t.status !== "in_transit";
          const estimatedEtaMs = isParked
            ? estimateDepartMs({
                arrivedAtMs,
                currentHub,
                nextHub,
                isCenter: centerHubId !== undefined && hubId === centerHubId,
                config: timing,
              })
            : null;

          const driverRow =
            t.driver_id !== null ? driverById.get(t.driver_id) : undefined;
          const driver: HubTrailerDriverDto | null =
            driverRow === undefined
              ? null
              : {
                  driverId: driverRow.driver_id,
                  dutyStatus: driverRow.status,
                  remainingDriveMinutes: driverRow.remaining_drive_minutes,
                };

          return {
            trailerId: t.trailer_id,
            status: t.status,
            dockDoorId: t.dock_door_id,
            assignedPackageIds: t.assigned_package_ids,
            driver,
            rearToNose: plan?.rearToNose ?? [],
            utilization: plan?.utilization ?? null,
            nextHubId,
            arrivedAtMs,
            estimatedEtaMs,
            etaIsEstimate: estimatedEtaMs !== null,
          };
        }),
      );

      // P3: stable, id-sorted panel ordering.
      trailers.sort((a, b) =>
        a.trailerId < b.trailerId ? -1 : a.trailerId > b.trailerId ? 1 : 0,
      );

      return { hubId, trailers, inventoryBalance };
    },
  );
}
