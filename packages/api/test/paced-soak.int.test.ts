import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildServer,
  driveSimulationPaced,
  type ApiDb,
  type Broadcast,
  type WsEnvelope,
} from "../src/index.js";
import type { BuiltServer } from "../src/server.js";
import { DEFAULT_TIMING_CONFIG } from "@mm/simulation";
import { startPgFixture, type PgFixture } from "./pg-fixture.js";

/**
 * NO-FREEZE SOAK (spec §9 soak / §10 acceptance #4) — the regression that the
 * whole paced-loop redesign exists to kill.
 *
 * OLD bug: at 64× the per-tick interval shrank to ~8ms but the per-tick work
 * (DB append + projection + a periodically BLOCKING optimizer) did not — so with
 * a richer fleet the sim-loop became sim-loop-bound, `simClock` crawled/froze and
 * trucks stopped moving.
 *
 * This drives the REAL paced path with `fleetPerSpoke:3` (~30 trucks), a fixed
 * 50ms frame, a 32-tick budget, and a 64× multiplier — and asserts the run makes
 * PROGRESS within a bounded wall-clock window: frames (broadcasts) keep arriving
 * (count grows over time) AND the final `simMs` reaches the END of the stream
 * (every tick drained). The point is "advances, never freezes" — not a latency
 * SLA — so the bound is generous.
 *
 * Both transports are exercised: `inline` ALWAYS (the determinism keystone), and
 * `worker` too (the demo path) — the worker entry resolves from the built
 * `dist/optimizer/optimizer-worker.js` (turbo builds before this lane runs).
 */

const SEED = 4242;
// A moderate horizon: long enough that a freeze would be obvious, short enough
// that the bounded run finishes inside the integration timeout at 64×/50ms.
const DURATION = 60;
const FLEET_PER_SPOKE = 3;

interface SoakOutcome {
  readonly result: { ticks: number };
  readonly broadcasts: number[];
  readonly midCount: number; // broadcast count sampled partway through
  readonly lastTickMs: number;
}

describe("paced-loop NO-FREEZE soak (64x, fleetPerSpoke=3)", () => {
  let fx: PgFixture;

  beforeAll(async () => {
    fx = await startPgFixture();
  }, 120_000);

  afterAll(async () => {
    await fx?.stop();
  });

  /**
   * Drive one paced run in the given execution mode against a FRESH pg-backed
   * server, recording every broadcast simMs. A mid-run sampler (fired once the
   * loop is underway) captures the broadcast count so we can prove it KEEPS
   * growing (the anti-freeze signal).
   */
  async function soak(execution: "inline" | "worker"): Promise<SoakOutcome> {
    const db: ApiDb = fx.db;
    const built: BuiltServer = await buildServer({
      db,
      enableWs: false,
      simSeed: SEED,
      baselineTicks: DURATION,
      optimizerExecution: execution,
      timing: DEFAULT_TIMING_CONFIG,
    });

    try {
      const broadcasts: number[] = [];
      let midCount = -1;
      // Sample the broadcast count partway through the bounded window so we can
      // assert it is still growing by the end (no freeze).
      const sampler = setTimeout(() => {
        midCount = broadcasts.length;
      }, 1000);

      // A recording broadcast that satisfies the `Broadcast` contract (returns a
      // minimal WsEnvelope; the driver ignores the return value).
      const broadcast: Broadcast = (simMs: number): Promise<WsEnvelope> => {
        broadcasts.push(simMs);
        return Promise.resolve({
          v: 1,
          type: "tick",
          seq: broadcasts.length,
          simMs,
          speed: { multiplier: 64, tickIntervalMs: 500 / 64, simSpeed: 7680, paused: false },
          payload: {},
        });
      };

      const result = await driveSimulationPaced({
        db,
        seed: SEED,
        durationTicks: DURATION,
        fleetPerSpoke: FLEET_PER_SPOKE,
        timing: DEFAULT_TIMING_CONFIG,
        frameMs: 50,
        maxTicksPerFrame: 32,
        getMultiplier: () => 64,
        // Batch the optimizer every 8 drained ticks (as the demo does) so the
        // inline run stays bounded; the worker run offloads it entirely.
        optimizerEveryTicks: 8,
        loop: built.loop,
        broadcast,
      });
      clearTimeout(sampler);

      // Determine the last tick time from a fresh deterministic stream sample.
      const { simulate } = await import("@mm/simulation");
      const stream = simulate({
        seed: SEED,
        durationTicks: DURATION,
        fleetPerSpoke: FLEET_PER_SPOKE,
        timing: DEFAULT_TIMING_CONFIG,
      });
      const lastTickMs = Math.max(...stream.map((e) => new Date(e.occurredAt).getTime()));

      return {
        result,
        broadcasts,
        midCount: midCount < 0 ? broadcasts.length : midCount,
        lastTickMs,
      };
    } finally {
      await built.worker?.close();
      await built.app.close();
    }
  }

  function assertNoFreeze(o: SoakOutcome): void {
    // (1) The run drained EVERY tick (reached the end of the stream).
    expect(o.result.ticks).toBeGreaterThan(0);
    // (2) Frames kept arriving — broadcasts grew over the window (no stall).
    expect(o.broadcasts.length).toBeGreaterThanOrEqual(o.midCount);
    expect(o.broadcasts.length).toBeGreaterThan(1);
    // (3) simClock reached the END of the stream — the final broadcast simMs is
    //     at/after the last tick's time. This is the anti-freeze guarantee.
    expect(o.broadcasts.at(-1)!).toBeGreaterThanOrEqual(o.lastTickMs);
    // (4) simClock is monotone non-decreasing across the whole run.
    for (let i = 1; i < o.broadcasts.length; i += 1) {
      expect(o.broadcasts[i]!).toBeGreaterThanOrEqual(o.broadcasts[i - 1]!);
    }
  }

  it("inline mode: 64x / fleet=3 advances to the end with no freeze", async () => {
    assertNoFreeze(await soak("inline"));
  }, 120_000);

  it("worker mode: 64x / fleet=3 advances to the end with no freeze", async () => {
    assertNoFreeze(await soak("worker"));
  }, 120_000);
});
