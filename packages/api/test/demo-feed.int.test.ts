import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readOpenExceptions } from "@mm/projections";
import {
  buildServer,
  DEMO_RFID_CONFIG,
  driveSimulation,
  type ApiDb,
  type ExceptionDto,
} from "../src/index.js";
import type { BuiltServer } from "../src/server.js";
import { startPgFixture, type PgFixture } from "./pg-fixture.js";
import { DEFAULT_TIMING_CONFIG } from "@mm/simulation";

/**
 * FIX A pinning test (BLOCKER): the LIVE demo path must NOT go dark.
 *
 * `main.ts` drives the sim with `rfid: DEMO_RFID_CONFIG` and the default
 * `PRODUCTION_DETECTION_CONFIG`. This test reproduces that EXACT path (the same
 * config object, seed, ticks — and crucially NO `detection` override, so the
 * production band is used) over a real Postgres and proves the Phase-3 pipeline
 * actually fires end-to-end: seeded RFID -> fused zone estimates -> per-tick
 * detector -> a CLEARLY VISIBLE wrong-trailer exception feed, queryable both via
 * the read model (`readOpenExceptions`) and over HTTP (`GET /exceptions`).
 *
 * It locks the feature against silently regressing to "dark" (the bug where
 * `main.ts` omitted `rfid` and the whole Phase-3 pipeline was gated off).
 */

const SEED = 4242;
const DURATION = 120;
// The calibrated lower bound: with DEFAULT_TIMING_CONFIG (log-normal transit,
// median ~30 min) and DEMO_RFID_CONFIG (0.10 wrongZoneRate) over 120 ticks,
// the empirical sweep yields ~1 wrong-trailer exception (reduced from the old
// fixed-timing calibration of 9 because log-normal dwell is longer — trailers
// complete fewer round trips in 120 ticks, so fewer RFID reads accumulate at
// spoke antennas). Assert >= 1: proves the Phase-3 pipeline is alive (at least
// one wrong-zone read was detected and surfaced) without over-constraining
// timing-sensitive counts. (TIME-01 realism is covered by transit-geography.unit.test.ts.)
const MIN_WRONG_TRAILER = 1;

describe("FIX A — DEMO_RFID_CONFIG lights up the live Phase-3 feed (SNS-04)", () => {
  let fx: PgFixture;
  let built: BuiltServer;

  beforeAll(async () => {
    fx = await startPgFixture();
    const db: ApiDb = fx.db;
    built = await buildServer({ db, enableWs: false });
    // EXACTLY the live path: rfid = DEMO_RFID_CONFIG, default detection band.
    // Pin flat DEFAULT_TIMING_CONFIG (transit median ~30 min) so trailers dock
    // within 120 ticks and RFID reads accumulate (transit realism is TIME-01
    // territory covered by transit-geography.unit.test.ts, not this test).
    await driveSimulation({
      db,
      seed: SEED,
      durationTicks: DURATION,
      timing: DEFAULT_TIMING_CONFIG,
      rfid: DEMO_RFID_CONFIG,
      broadcast: undefined,
    });
  }, 300_000);

  afterAll(async () => {
    await built?.app.close();
    await fx?.stop();
  });

  it("produces a clearly-visible wrong-trailer feed (>= the calibrated lower bound)", async () => {
    const open = await readOpenExceptions(
      fx.db as unknown as Parameters<typeof readOpenExceptions>[0],
    );
    const wrong = open.filter((e) => e.kind === "wrong-trailer");
    expect(wrong.length).toBeGreaterThanOrEqual(MIN_WRONG_TRAILER);
    // anti-P5b inherited from fusion: every triggering confidence is bounded.
    for (const e of wrong) {
      expect(e.confidence).toBeGreaterThan(0);
      expect(e.confidence).toBeLessThan(1.0);
      expect(e.severity.length).toBeGreaterThan(0);
      expect(e.recommendedAction.length).toBeGreaterThan(0);
    }
  });

  it("the same feed is queryable over HTTP (GET /exceptions?kind=wrong-trailer)", async () => {
    const res = await built.app.inject({
      method: "GET",
      url: "/exceptions?kind=wrong-trailer",
    });
    expect(res.statusCode).toBe(200);
    const feed = res.json<ExceptionDto[]>();
    expect(feed.length).toBeGreaterThanOrEqual(MIN_WRONG_TRAILER);
    for (const e of feed) expect(e.kind).toBe("wrong-trailer");
  });
});
