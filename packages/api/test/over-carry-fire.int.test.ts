import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  driveSimulation,
  DEMO_RFID_CONFIG,
  DEMO_OVER_CARRY_CONFIG,
  type ApiDb,
} from "../src/index.js";
import { readOpenExceptions } from "@mm/projections";
import type { ProjectionDb } from "@mm/projections";
import type { Kysely } from "kysely";
import { startPgFixture, type PgFixture } from "./pg-fixture.js";

/**
 * F-07 / SNS-05 — the LIVE missed-unload FIRE proof (real Postgres, real path).
 *
 * Drives the EXACT live demo path (`driveSimulation` with `rfid =
 * DEMO_RFID_CONFIG`) PLUS the new opt-in `overCarry` knob, then reads the
 * persisted exceptions projection. A `missed-unload` exception in that feed is a
 * REAL fire: the seeded simulator produced a spoke-origin `TrailerDeparted`
 * carrying a package destined for that spoke, a portal read positively observed
 * it aboard, and the UNCHANGED detector (`detectMissedUnload`) raised the
 * exception through the live driver's `departedHubs` / `destHubIndex` plumbing.
 *
 * This is NOT a hand-fed predicate — every input flows from the real engine
 * stream through the real inline projections + detector into Postgres.
 *
 * This suite is deliberately a NEW dedicated file (NOT `live-demo.int.test.ts`).
 *
 * Performance: ONE testcontainer is shared across the whole describe; the store +
 * projection tables are TRUNCATEd between drives. Spinning a fresh container per
 * drive is the dominant cost and is timeout-fragile on a loaded Docker daemon.
 */

const SEED = 4242;
const DURATION = 120;

/** Event-store + projection tables reset between drives (one shared fixture). */
const RESET_TABLES = [
  // event store
  "events",
  "streams",
  "projection_checkpoints",
  // operational + observed projections (detector inputs/outputs)
  "package_location",
  "trailer_state",
  "hub_inventory",
  "tag_registry",
  "zone_estimate",
  "exceptions",
  "exception_kpi",
] as const;

/** View the fixture handle as the projection read schema. */
function projDb(db: ApiDb): Kysely<ProjectionDb> {
  return db as unknown as Kysely<ProjectionDb>;
}

/** TRUNCATE the store + projection tables so the next drive starts clean. */
async function resetDb(db: ApiDb): Promise<void> {
  for (const table of RESET_TABLES) {
    // Each table is reset independently; a missing table is tolerated (some
    // projections may not exist in every schema revision).
    await sql`TRUNCATE TABLE ${sql.ref(table)} RESTART IDENTITY CASCADE`
      .execute(db as unknown as Kysely<unknown>)
      .catch(() => undefined);
  }
}

describe("F-07 / SNS-05 — over-carry makes the missed-unload detector fire LIVE", () => {
  let fx: PgFixture;
  // The accumulated calibration sweep table (one row per rate run).
  const sweep = new Map<number, number>();

  beforeAll(async () => {
    fx = await startPgFixture();
  }, 180_000);

  afterAll(async () => {
    await fx?.stop();
    if (sweep.size > 0) {
      const table = [...sweep.entries()].sort((a, b) => a[0] - b[0]);
      console.log(
        "[over-carry sweep] seed 4242 / 120 ticks / DEMO_RFID_CONFIG →",
        table.map(([rate, count]) => `${rate}=${count}`).join("  "),
      );
    }
  });

  /** Reset, drive the live path at one over-carry rate, return missed-unload feed. */
  async function driveAndCount(
    overCarry: number,
  ): Promise<{ missedUnloadCount: number; packageIds: string[]; confidences: number[]; hubIds: (string | null)[] }> {
    await resetDb(fx.db);
    await driveSimulation({
      db: fx.db,
      seed: SEED,
      durationTicks: DURATION,
      rfid: DEMO_RFID_CONFIG,
      overCarry,
      broadcast: undefined,
    });
    const open = await readOpenExceptions(projDb(fx.db));
    const missed = open.filter((e) => e.kind === "missed-unload");
    return {
      missedUnloadCount: missed.length,
      packageIds: missed.map((e) => e.packageId).sort(),
      confidences: missed.map((e) => e.confidence),
      hubIds: missed.map((e) => e.hubId),
    };
  }

  // CALIBRATION: drive each candidate rate (one drive per test). The shared
  // fixture is reset between drives, so each test costs ~one 120-tick drive. The
  // demo rate (0.15) is in the set, so the sweep is self-checking; the band
  // assertions pin the calibration.
  it.each([
    { rate: 0.05, min: 0, max: 5 },
    { rate: 0.1, min: 0, max: 5 },
    { rate: 0.15, min: 1, max: 5 }, // the chosen DEMO rate — must be in 1-5
    { rate: 0.2, min: 1, max: 5 },
  ])(
    "CALIBRATION rate $rate → live missed-unloads in [$min,$max] (seed 4242, 120 ticks)",
    async ({ rate, min, max }) => {
      const r = await driveAndCount(rate);
      sweep.set(rate, r.missedUnloadCount);
      expect(r.missedUnloadCount).toBeGreaterThanOrEqual(min);
      expect(r.missedUnloadCount).toBeLessThanOrEqual(max);
    },
    180_000,
  );

  it("the demo rate is in the swept calibration set (self-checking)", () => {
    expect([0.05, 0.1, 0.15, 0.2]).toContain(DEMO_OVER_CARRY_CONFIG.rate);
  });

  it(
    "FIRE: the demo over-carry config produces missedUnloadCount > 0 via the UNCHANGED detector",
    async () => {
      const r = await driveAndCount(DEMO_OVER_CARRY_CONFIG.rate);

      // A real fire: at least one missed-unload exception is persisted.
      expect(
        r.missedUnloadCount,
        "expected ≥1 live missed-unload exception with the demo over-carry config",
      ).toBeGreaterThan(0);

      // Every fired missed-unload cleared the calibrated 0.34 confidence gate
      // (the corroborating portal read lifts it above the uniform floor) and is
      // pinned to a SPOKE (not the center MEM) — the over-carry gate.
      for (const c of r.confidences) expect(c).toBeGreaterThan(0.34);
      for (const h of r.hubIds) expect(h).not.toBe("MEM");
    },
    180_000,
  );

  it(
    "DETERMINISM: same seed + demo over-carry ⇒ identical missed-unload count + packageIds",
    async () => {
      const a = await driveAndCount(DEMO_OVER_CARRY_CONFIG.rate);
      const b = await driveAndCount(DEMO_OVER_CARRY_CONFIG.rate);
      expect(b.missedUnloadCount).toBe(a.missedUnloadCount);
      expect(b.packageIds).toEqual(a.packageIds);
    },
    300_000,
  );
});
