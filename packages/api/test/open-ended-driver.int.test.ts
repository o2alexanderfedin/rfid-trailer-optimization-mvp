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
import type { Kysely } from "kysely";
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

  // A SHORT chunk so the run crosses MANY chunk boundaries quickly — the window
  // would balloon under the old prefix-regen model; the continuation-driven driver
  // discards drained ticks so it stays bounded. fleet 1 + small horizon keeps the
  // DB-bound run inside the timeout while still crossing ~6 chunk boundaries.
  const SMALL_CHUNK = 20;
  const MAX_TPF = 8;

  it("Task B: the retained tick window stays BOUNDED over a multi-chunk run", async () => {
    const db: ApiDb = fx.db;
    const built: BuiltServer = await buildServer({
      db,
      enableWs: false,
      simSeed: SEED + 1,
      baselineTicks: SMALL_CHUNK,
      optimizerExecution: "inline",
      timing: DEFAULT_TIMING_CONFIG,
    });

    try {
      // Stop after ~130 sim-ticks: > 6 chunks (SMALL_CHUNK=20) so the window MUST
      // have rolled many times. Under prefix-regen the window would be ~130; the
      // continuation driver keeps it ~one chunk.
      // Advance well past MANY chunk horizons (300 sim-ticks = 15 chunks of 20),
      // so the continuation has been advanced repeatedly and the window has rolled
      // many times. Under the old prefix-regen model the window held the WHOLE
      // prefix; the continuation driver discards drained ticks.
      const STOP_TICK = 300;
      const STOP_MS = EPOCH_MS + STOP_TICK * MS_PER_TICK;
      let lastSimMs = 0;
      const retainedSamples: number[] = [];
      const stopped = (): boolean => lastSimMs >= STOP_MS;

      await driveSimulationOpenEnded({
        db,
        seed: SEED + 1,
        durationTicks: SMALL_CHUNK,
        chunkTicks: SMALL_CHUNK,
        fleetPerSpoke: 1,
        timing: DEFAULT_TIMING_CONFIG,
        frameMs: 5,
        maxTicksPerFrame: MAX_TPF,
        getMultiplier: () => 512,
        optimizerEveryTicks: 8,
        loop: built.loop,
        broadcast: (simMs: number) => {
          lastSimMs = simMs;
          return Promise.resolve({
            v: 1,
            type: "tick" as const,
            seq: 1,
            simMs,
            simDay: 0,
            speed: { multiplier: 512, tickIntervalMs: 1, simSpeed: 1, paused: false },
            payload: {},
          });
        },
        onWindowState: ({ retainedTicks }) => retainedSamples.push(retainedTicks),
        stopped,
      });

      // The run advanced ~15 chunk horizons in SIM time (the continuation was
      // extended many times — proving no prefix regen / unbounded pre-bake).
      expect(lastSimMs).toBeGreaterThanOrEqual(STOP_MS);
      expect(retainedSamples.length).toBeGreaterThan(5);
      // The retained tick-GROUP window NEVER grows with run length: bounded by ~2
      // chunks + a frame regardless of how many chunks were crossed. (With realistic
      // transit most sim-ticks carry no events, so the window holds far fewer
      // tick-groups than chunk size — the cap is a generous upper bound.)
      const maxRetained = Math.max(...retainedSamples);
      expect(maxRetained).toBeLessThanOrEqual(SMALL_CHUNK * 2 + MAX_TPF + 1);
    } finally {
      await built.worker?.close();
      await built.app.close();
    }
  }, 120_000);

  it("Task C: retention prunes the event log below the watermark over a continuous run", async () => {
    const db: ApiDb = fx.db;
    const built: BuiltServer = await buildServer({
      db,
      enableWs: false,
      simSeed: SEED + 2,
      baselineTicks: SMALL_CHUNK,
      optimizerExecution: "inline",
      timing: DEFAULT_TIMING_CONFIG,
    });

    type EventsView = Kysely<{ events: { global_seq: string } }>;
    const ev = fx.db as unknown as EventsView;

    try {
      const STOP_MS = EPOCH_MS + 130 * MS_PER_TICK;
      let lastSimMs = 0;
      const stopped = (): boolean => lastSimMs >= STOP_MS;

      await driveSimulationOpenEnded({
        db,
        seed: SEED + 2,
        durationTicks: SMALL_CHUNK,
        chunkTicks: SMALL_CHUNK,
        fleetPerSpoke: 1,
        timing: DEFAULT_TIMING_CONFIG,
        frameMs: 5,
        maxTicksPerFrame: MAX_TPF,
        getMultiplier: () => 512,
        optimizerEveryTicks: 8,
        loop: built.loop,
        // Small margin so the prune actually bites within this short run.
        retention: { everyTicks: 10, retentionMargin: 20, staleHorizonMs: 0 },
        broadcast: (simMs: number) => {
          lastSimMs = simMs;
          return Promise.resolve({
            v: 1,
            type: "tick" as const,
            seq: 1,
            simMs,
            simDay: 0,
            speed: { multiplier: 512, tickIntervalMs: 1, simSpeed: 1, paused: false },
            payload: {},
          });
        },
        stopped,
      });

      const retained = Number(
        (
          await ev
            .selectFrom("events")
            .select((eb) => eb.fn.countAll().as("c"))
            .executeTakeFirstOrThrow()
        ).c,
      );
      const headSeq = Number(
        (
          await ev
            .selectFrom("events")
            .select((eb) => eb.fn.max("global_seq").as("mx"))
            .executeTakeFirstOrThrow()
        ).mx ?? 0,
      );
      // Rows were pruned: the retained count is strictly below the highest
      // global_seq ever assigned (the log is bounded, not cumulative).
      expect(headSeq).toBeGreaterThan(0);
      expect(retained).toBeLessThan(headSeq);
    } finally {
      await built.worker?.close();
      await built.app.close();
    }
  }, 120_000);
});
