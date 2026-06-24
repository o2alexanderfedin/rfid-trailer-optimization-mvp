import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildServer,
  driveSimulationOpenEnded,
  type ApiDb,
  type Broadcast,
  type WsEnvelope,
} from "../src/index.js";
import type { BuiltServer } from "../src/server.js";
import { DEFAULT_TIMING_CONFIG } from "@mm/simulation";
import { startPgFixture, type PgFixture } from "./pg-fixture.js";

/**
 * CONT-01/02 (Phase 19) — the OPEN-ENDED driver runs continuously past its
 * INITIAL chunk horizon and stops cleanly when its injected `stopped()` predicate
 * fires.
 *
 * This drives the REAL open-ended path against a fresh pg-backed server with a
 * small initial `durationTicks` (the chunk horizon) and a `stopped()` predicate
 * that flips true once the run has advanced WELL PAST that horizon — proving:
 *   (1) freight + departures keep flowing past the initial ceiling (chunked
 *       generation extends the horizon on demand; no pre-baked infinite stream),
 *   (2) the loop terminates promptly when stopped(),
 *   (3) simMs advances monotonically and the broadcast count keeps growing.
 *
 * Inline execution only (the determinism keystone) — the worker path is already
 * covered by paced-soak; open-endedness is orthogonal to the optimizer transport.
 */

const SEED = 7319;
// A SMALL initial horizon so the run must EXTEND it (chunked generation) to reach
// the stop threshold — exercising the open-ended continuation past the ceiling.
const INITIAL_HORIZON = 40;
const CHUNK_TICKS = 30;
const FLEET_PER_SPOKE = 2;

const EPOCH_MS = Date.parse("2026-04-01T00:00:00.000Z");
const MS_PER_TICK = 60_000;
// Stop once the run advances well past the initial horizon (proves continuation).
const STOP_AT_TICK = INITIAL_HORIZON * 4; // 160 ticks
const STOP_AT_MS = EPOCH_MS + STOP_AT_TICK * MS_PER_TICK;

describe("open-ended driver (CONT-01/02)", () => {
  let fx: PgFixture;

  beforeAll(async () => {
    fx = await startPgFixture();
  }, 120_000);

  afterAll(async () => {
    await fx?.stop();
  });

  it("runs past the initial horizon and stops cleanly on the stop signal", async () => {
    const db: ApiDb = fx.db;
    const built: BuiltServer = await buildServer({
      db,
      enableWs: false,
      simSeed: SEED,
      baselineTicks: INITIAL_HORIZON,
      optimizerExecution: "inline",
      timing: DEFAULT_TIMING_CONFIG,
    });

    try {
      const broadcasts: number[] = [];
      let lastSimMs = 0;
      // Stop when the broadcast sim clock crosses the threshold (well past the
      // initial horizon) — cooperative, read fresh each frame by the driver.
      const stopped = (): boolean => lastSimMs >= STOP_AT_MS;

      const broadcast: Broadcast = (simMs: number): Promise<WsEnvelope> => {
        broadcasts.push(simMs);
        lastSimMs = simMs;
        return Promise.resolve({
          v: 1,
          type: "tick",
          seq: broadcasts.length,
          simMs,
          simDay: Math.max(0, Math.floor((simMs - EPOCH_MS) / (MS_PER_TICK * 1440))),
          speed: { multiplier: 64, tickIntervalMs: 500 / 64, simSpeed: 7680, paused: false },
          payload: {},
        });
      };

      const result = await driveSimulationOpenEnded({
        db,
        seed: SEED,
        durationTicks: INITIAL_HORIZON,
        chunkTicks: CHUNK_TICKS,
        fleetPerSpoke: FLEET_PER_SPOKE,
        timing: DEFAULT_TIMING_CONFIG,
        frameMs: 25,
        maxTicksPerFrame: 16,
        getMultiplier: () => 64,
        optimizerEveryTicks: 8,
        loop: built.loop,
        broadcast,
        stopped,
      });

      // (1) The run drained ticks and terminated.
      expect(result.ticks).toBeGreaterThan(0);
      // (2) It advanced PAST the initial horizon (continuous operation past the
      //     ceiling — the whole point of CONT-01/02).
      const lastBroadcast = broadcasts.at(-1)!;
      expect(lastBroadcast).toBeGreaterThanOrEqual(STOP_AT_MS);
      // (3) Frames kept arriving.
      expect(broadcasts.length).toBeGreaterThan(2);
      // (4) simMs is monotone non-decreasing.
      for (let i = 1; i < broadcasts.length; i += 1) {
        expect(broadcasts[i]!).toBeGreaterThanOrEqual(broadcasts[i - 1]!);
      }
    } finally {
      await built.worker?.close();
      await built.app.close();
    }
  }, 120_000);
});
