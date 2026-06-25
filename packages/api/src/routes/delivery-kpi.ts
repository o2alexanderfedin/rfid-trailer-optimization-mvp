import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import type { ApiDb } from "./queries.js";

/**
 * `GET /api/delivery-kpi` (OUT-05 P2 / D-22-3) — the event-derived delivery KPI.
 *
 * Returns `{ deliveredCount, onTimeCount }`, the monotonic counters the operator
 * panel's `DeliveryKpi` widget renders. Per D-22-3 the totals are derived from the
 * IMMUTABLE `events` log (every `PackageDelivered` fact is retained there), NOT a
 * `COUNT(*)` over `package_location` / `hub_inventory` — those rows are
 * DELETE-purged on delivery (OUT-04), so a projection-table count would
 * UNDERCOUNT. The `events` log is append-only and never purged, so the aggregate
 * over it is the correct, monotonic source of truth.
 *
 * Read-only, no writes. The `(event_type, global_seq)` index serves the
 * `WHERE event_type = 'PackageDelivered'` filter without a full scan.
 */

/** The `GET /api/delivery-kpi` response (D-22-3 event-derived counters). */
export interface DeliveryKpiDto {
  /** Total packages delivered (monotonic; every PackageDelivered event). */
  readonly deliveredCount: number;
  /** Subset delivered on time (`onTime === true` in the event payload). */
  readonly onTimeCount: number;
}

/**
 * Read the delivery KPI counters from the immutable event log (D-22-3). One
 * parameterized aggregate query over the `PackageDelivered` rows: total count +
 * the on-time subset (the `data->>'onTime'` JSONB text is `'true'`/`'false'`).
 */
export async function readDeliveryKpi(db: ApiDb): Promise<DeliveryKpiDto> {
  const row = await db
    .selectFrom("events")
    .select([
      (eb) => eb.fn.countAll().as("delivered"),
      () =>
        sql<string | number>`count(*) filter (where data->>'onTime' = 'true')`.as(
          "onTime",
        ),
    ])
    .where("event_type", "=", "PackageDelivered")
    .executeTakeFirst();
  // `count(*)` comes back as bigint (string via the pg driver); coerce to number.
  const deliveredCount = row === undefined ? 0 : Number(row.delivered);
  const onTimeCount = row === undefined ? 0 : Number(row.onTime);
  return { deliveredCount, onTimeCount };
}

/**
 * Register the delivery-KPI route on `app`. `db` is the composition-root handle.
 * The server registers it WITHOUT the `/api` prefix; the Vite dev proxy rewrites
 * the client's `/api/delivery-kpi` → `/delivery-kpi` (the same convention as
 * every other route here — cf. `/kpis`, `/hubs`).
 */
export function registerDeliveryKpiRoutes(app: FastifyInstance, db: ApiDb): void {
  app.get("/delivery-kpi", (): Promise<DeliveryKpiDto> => {
    return readDeliveryKpi(db);
  });
}
