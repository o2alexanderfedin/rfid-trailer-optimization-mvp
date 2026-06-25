import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_TIMING_CONFIG } from "@mm/domain";
import { simulate, type TimingConfig } from "@mm/simulation";
import {
  buildServer,
  driveSimulation,
  type ApiDb,
} from "../src/index.js";
import type { DeliveryKpiDto } from "../src/routes/delivery-kpi.js";
import type { BuiltServer } from "../src/server.js";
import { startPgFixture, type PgFixture } from "./pg-fixture.js";

/**
 * OUT-05 (P2 / D-22-3) — `GET /api/delivery-kpi` over a REAL Postgres + a seeded
 * outbound-delivery sim. We drive a SHORT bounded run with
 * `outboundDeliveryEnabled: true`, then assert the endpoint's event-derived
 * counters match the `PackageDelivered` facts in the immutable log (NOT a count
 * over the DELETE-purged package tables).
 *
 * Bounded (gate-hygiene): durationTicks = 90 so the per-event inline fold + append
 * stay fast. Inducted freight has SLA deadlines; deliveries fire within the window.
 */

const SEED = 4242;
const DURATION = 90;
const TIMING: TimingConfig = DEFAULT_TIMING_CONFIG;

/** The expected counters, computed from the same seeded stream (oracle). */
function expectedKpi(): DeliveryKpiDto {
  const stream = simulate({
    seed: SEED,
    durationTicks: DURATION,
    outboundDeliveryEnabled: true,
    inductionEnabled: true,
    timing: TIMING,
  });
  let deliveredCount = 0;
  let onTimeCount = 0;
  for (const { event } of stream) {
    if (event.type !== "PackageDelivered") continue;
    deliveredCount += 1;
    if ((event).payload.onTime) onTimeCount += 1;
  }
  return { deliveredCount, onTimeCount };
}

describe("GET /api/delivery-kpi (OUT-05 / D-22-3) over a seeded outbound sim", () => {
  let fx: PgFixture;
  let built: BuiltServer;

  beforeAll(async () => {
    fx = await startPgFixture();
    const db: ApiDb = fx.db;
    built = await buildServer({ db, enableWs: false });
    await driveSimulation({
      db,
      seed: SEED,
      durationTicks: DURATION,
      outboundDeliveryEnabled: true,
      inductionEnabled: true,
      timing: TIMING,
      broadcast: undefined,
    });
  }, 180_000);

  afterAll(async () => {
    await built?.app.close();
    await fx?.stop();
  });

  it("returns the event-derived deliveredCount + onTimeCount from the immutable log", async () => {
    const oracle = expectedKpi();
    // Sanity: the bounded run actually produced deliveries (else the test is vacuous).
    expect(oracle.deliveredCount).toBeGreaterThan(0);

    const res = await built.app.inject({ method: "GET", url: "/delivery-kpi" });
    expect(res.statusCode).toBe(200);
    const body = res.json<DeliveryKpiDto>();
    expect(body.deliveredCount).toBe(oracle.deliveredCount);
    expect(body.onTimeCount).toBe(oracle.onTimeCount);
    // onTimeCount can never exceed deliveredCount (a structural invariant).
    expect(body.onTimeCount).toBeLessThanOrEqual(body.deliveredCount);
  });
});
