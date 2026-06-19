import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { simulate } from "@mm/simulation";
import {
  buildServer,
  driveSimulation,
  type ApiDb,
  type ExceptionDto,
  type ExceptionKpiDto,
  type ZoneEstimateDto,
} from "../src/index.js";
import type { BuiltServer } from "../src/server.js";
import { startPgFixture, type PgFixture } from "./pg-fixture.js";

/**
 * Plan 03-07 (SNS-04/05) — the exception feed + FP-rate KPI + zone-estimate
 * queries END-TO-END over a REAL Postgres (Testcontainers), driven by a SEEDED
 * NOISY sim whose driver now runs `runDetection` per tick. This closes the
 * vertical slice: sim emits RFID -> fusion scores zones -> detector compares
 * planned vs observed -> exceptions surface over HTTP.
 *
 * One noisy sim is driven in `beforeAll`; each test asserts a facet:
 *  (a) GET /exceptions returns a plausible feed (wrong-trailer and/or
 *      missed-unload) WITH severity + recommendedAction;
 *  (b) GET /exceptions/kpi returns a LOW false-positive rate (feed not flooded);
 *  (c) a package that got NO reads has NO exception and is not marked missing
 *      (anti-P6, end-to-end through the API);
 *  (d) GET /packages/:id/zone returns a zone + confidence < 1.0 for an OBSERVED
 *      package, and 404 for an unobserved one (absence != fabricated estimate);
 *  (e) re-running the same seed yields the same feed (determinism).
 */

const SEED = 4242;
// Enough ticks for departures + dwell so RFID reads + corroborated disagreements
// surface, kept small so the per-tick inline-fold + detection stays fast.
const DURATION = 50;
// A noisy RFID profile: a high wrong-zone corruption rate produces credible
// wrong-trailer disagreements (the demo "RFID caught it"), a low miss rate + a
// fat antenna burst lets the dwell window CORROBORATE some reads above the
// single-read floor — so the feed spans the calibrated info/warning band and the
// FP-rate KPI discriminates (it is not all-marginal).
const RFID = { wrongZoneRate: 0.5, missRate: 0.02, antennaBurst: 10 } as const;

/** Drive a fresh fixture + server through a seeded NOISY sim with detection. */
async function driveNoisy(): Promise<{ fx: PgFixture; built: BuiltServer }> {
  const fx = await startPgFixture();
  const db: ApiDb = fx.db;
  const built = await buildServer({ db, enableWs: false });
  await driveSimulation({
    db,
    seed: SEED,
    durationTicks: DURATION,
    rfid: RFID,
    broadcast: undefined,
  });
  return { fx, built };
}

describe("exception feed + KPI + zone queries over a seeded noisy sim (SNS-04/05)", () => {
  let fx: PgFixture;
  let built: BuiltServer;

  beforeAll(async () => {
    ({ fx, built } = await driveNoisy());
  }, 300_000);

  afterAll(async () => {
    await built?.app.close();
    await fx?.stop();
  });

  it("(a) GET /exceptions returns plausible alerts WITH severity + recommendedAction", async () => {
    const res = await built.app.inject({ method: "GET", url: "/exceptions" });
    expect(res.statusCode).toBe(200);
    const feed = res.json<ExceptionDto[]>();
    expect(Array.isArray(feed)).toBe(true);
    expect(feed.length).toBeGreaterThan(0); // a noisy run produced disagreements
    for (const e of feed) {
      expect(["wrong-trailer", "missed-unload"]).toContain(e.kind);
      expect(e.packageId.length).toBeGreaterThan(0);
      expect(e.severity.length).toBeGreaterThan(0);
      expect(e.recommendedAction.length).toBeGreaterThan(0);
      expect(e.confidence).toBeGreaterThan(0);
      expect(e.confidence).toBeLessThan(1.0); // anti-P5b inherited from fusion
      expect(typeof e.occurredAt).toBe("string");
    }
    // The feed is deterministically ordered by occurredAt then exceptionId.
    const ordered = [...feed].sort((a, b) =>
      a.occurredAt !== b.occurredAt
        ? a.occurredAt < b.occurredAt
          ? -1
          : 1
        : a.exceptionId < b.exceptionId
          ? -1
          : a.exceptionId > b.exceptionId
            ? 1
            : 0,
    );
    expect(feed.map((e) => e.exceptionId)).toEqual(ordered.map((e) => e.exceptionId));
  });

  it("(a') the ?kind filter narrows the feed to one validated kind", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: "/exceptions?kind=wrong-trailer",
    });
    expect(res.statusCode).toBe(200);
    const feed = res.json<ExceptionDto[]>();
    for (const e of feed) expect(e.kind).toBe("wrong-trailer");

    // An invalid kind is rejected by the schema (T-03-19), not silently ignored.
    const bad = await built.app.inject({ method: "GET", url: "/exceptions?kind=bogus" });
    expect(bad.statusCode).toBe(400);
  });

  it("(b) GET /exceptions/kpi is a real ratio that discriminates (feed not flooded)", async () => {
    const res = await built.app.inject({ method: "GET", url: "/exceptions/kpi" });
    expect(res.statusCode).toBe(200);
    const kpi = res.json<ExceptionKpiDto>();

    // A genuine, queryable ratio in [0, 1] — NOT a placeholder.
    expect(kpi.totalExceptions).toBeGreaterThan(0);
    expect(kpi.lowConfidenceExceptions).toBeLessThanOrEqual(kpi.totalExceptions);
    expect(kpi.falsePositiveRate).toBeGreaterThanOrEqual(0);
    expect(kpi.falsePositiveRate).toBeLessThanOrEqual(1);
    expect(kpi.falsePositiveRate).toBeCloseTo(
      kpi.lowConfidenceExceptions / kpi.totalExceptions,
      10,
    );

    // The KEY credibility property: the severity calibration DISCRIMINATES —
    // the feed is not entirely marginal noise. At least one CREDIBLE
    // (warning/critical) exception exists, so the FP-rate is strictly < 1.0.
    // (A degenerate engine that mapped every disagreement to `info` would read
    // 1.0 — meaningless. This proves the calibrated band is meaningful.)
    const feed = (
      await built.app.inject({ method: "GET", url: "/exceptions" })
    ).json<ExceptionDto[]>();
    const credible = feed.filter((e) => e.severity !== "info");
    expect(credible.length).toBeGreaterThan(0);
    expect(kpi.falsePositiveRate).toBeLessThan(1);

    // Not flooded: the deduped feed stays bounded (one row per distinct
    // disagreement), never per-read — far below the raw observation count.
    const observed = await fx.db
      .selectFrom("zone_estimate")
      .select("package_id")
      .execute();
    expect(kpi.totalExceptions).toBeLessThanOrEqual(observed.length);
  });

  it("(c) a planned-but-NEVER-observed package has NO exception (anti-P6 through the API)", async () => {
    const feed = (
      await built.app.inject({ method: "GET", url: "/exceptions" })
    ).json<ExceptionDto[]>();
    const flagged = new Set(feed.map((e) => e.packageId));

    // Find a planned (created) package that received NO observation at all.
    const stream = simulate({ seed: SEED, durationTicks: DURATION, rfid: RFID });
    const created = new Set<string>();
    for (const e of stream) {
      if (e.event.type === "PackageCreated") created.add(e.event.payload.packageId);
    }
    const observedRows = await fx.db
      .selectFrom("zone_estimate")
      .select("package_id")
      .execute();
    const observed = new Set(observedRows.map((r) => r.package_id));
    const ghost = [...created].find((p) => !observed.has(p));
    expect(ghost).toBeDefined();

    // The unobserved package is never flagged, and its zone query is a 404 — its
    // absence is NEVER a fabricated estimate or a manufactured "missing".
    expect(flagged.has(ghost!)).toBe(false);
    const zoneRes = await built.app.inject({
      method: "GET",
      url: `/packages/${ghost}/zone`,
    });
    expect(zoneRes.statusCode).toBe(404);

    // Structural keystone: every open exception has a backing observation.
    for (const p of flagged) expect(observed.has(p)).toBe(true);
  });

  it("(d) GET /packages/:id/zone exposes zone + confidence < 1.0 (never coordinates)", async () => {
    const observedRows = await fx.db
      .selectFrom("zone_estimate")
      .select(["package_id"])
      .orderBy("package_id", "asc")
      .execute();
    expect(observedRows.length).toBeGreaterThan(0);
    const pkg = observedRows[0]!.package_id;

    const res = await built.app.inject({ method: "GET", url: `/packages/${pkg}/zone` });
    expect(res.statusCode).toBe(200);
    const zone = res.json<ZoneEstimateDto>();
    expect(zone.packageId).toBe(pkg);
    expect(["rear", "middle", "nose"]).toContain(zone.estimatedZone);
    expect(zone.confidence).toBeGreaterThan(0);
    expect(zone.confidence).toBeLessThan(1.0); // anti-P5b: never certain
    expect(typeof zone.lastObservedAt).toBe("string");
    // RFID-is-not-coordinates: the DTO exposes ONLY zone + confidence, no (x,y).
    expect(zone).not.toHaveProperty("x");
    expect(zone).not.toHaveProperty("y");
    expect(zone).not.toHaveProperty("lat");
    expect(zone).not.toHaveProperty("lon");
  });

  it("(e) re-running the same seed yields the SAME feed (determinism)", async () => {
    const feedA = (
      await built.app.inject({ method: "GET", url: "/exceptions" })
    ).json<ExceptionDto[]>();

    const second = await driveNoisy();
    try {
      const feedB = (
        await second.built.app.inject({ method: "GET", url: "/exceptions" })
      ).json<ExceptionDto[]>();
      // Same seed -> same disagreements -> same exception identities (order incl.).
      expect(feedB.map((e) => e.exceptionId)).toEqual(feedA.map((e) => e.exceptionId));
      expect(feedB.map((e) => e.severity)).toEqual(feedA.map((e) => e.severity));
    } finally {
      await second.built.app.close();
      await second.fx.stop();
    }
  }, 300_000);
});
