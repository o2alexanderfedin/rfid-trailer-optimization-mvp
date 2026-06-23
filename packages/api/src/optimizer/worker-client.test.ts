/**
 * Real-worker round-trip + parity + shutdown for the worker-thread optimizer
 * (Task 6). A long-lived `worker_threads` worker runs the PURE `runEpoch`; the
 * client posts `{id, epoch, input, weights}` and resolves with the matching
 * `EpochResult`. Parity: the worker's result DEEP-EQUALS the inline `runEpoch`
 * for the same input (no logic divergence — only the transport differs).
 *
 * RESOLUTION NOTE: the worker entry must be a runnable `.js`. The gate runs
 * `pnpm build` before the unit lane, so `dist/optimizer/optimizer-worker.js`
 * exists; the client resolves it (sibling in built mode, package `dist` under
 * vitest src mode). If `dist` is missing (e.g. a bare `vitest` run with no prior
 * build) the worker cannot spawn — this test guards on that and reports clearly.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_OBJECTIVE_WEIGHTS,
  runEpoch,
  type Epoch,
  type EpochInput,
  type TwinSnapshot,
} from "@mm/optimizer";
import { makeWorkerOptimizer } from "./worker-client.js";

const SNAPSHOT: TwinSnapshot = {
  hubs: ["ATL", "CHI"],
  routes: [{ routeId: "r1", fromHubId: "ATL", toHubId: "CHI", travelMin: 30, capacity: 200 }],
  trailers: [
    {
      trailerId: "T001",
      currentHubId: "ATL",
      departureMin: 9999,
      capacity: 50,
      route: [{ hubId: "CHI", stopIndex: 0 }],
      blocks: [{ blockId: "pkg-01", nextUnloadHubId: "CHI", volume: 1 }],
    },
  ],
};

const EPOCH: Epoch = { epochId: "e1", nowMin: 1, freezeWindowMin: 10 };
const INPUT: EpochInput = { events: [], twinSnapshot: SNAPSHOT };

/** True when the built worker entry exists (the gate builds before the unit lane). */
function workerBuilt(): boolean {
  const dist = fileURLToPath(new URL("../../dist/optimizer/optimizer-worker.js", import.meta.url));
  const sibling = fileURLToPath(new URL("./optimizer-worker.js", import.meta.url));
  return existsSync(dist) || existsSync(sibling);
}

describe("makeWorkerOptimizer — real worker_threads round-trip + parity", () => {
  it("worker result DEEP-EQUALS inline runEpoch (parity), then close() rejects pending runs", async () => {
    expect(
      workerBuilt(),
      "dist/optimizer/optimizer-worker.js missing — run `pnpm build` before the unit lane (the gate does).",
    ).toBe(true);

    const ref = runEpoch(EPOCH, INPUT, DEFAULT_OBJECTIVE_WEIGHTS);
    const worker = makeWorkerOptimizer();
    try {
      const got = await worker.run(EPOCH, INPUT, DEFAULT_OBJECTIVE_WEIGHTS);
      expect(got).toEqual(ref); // identical plan output — only the transport differs
    } finally {
      await worker.close();
    }

    // After shutdown a subsequent run must reject (the worker is gone).
    await expect(worker.run(EPOCH, INPUT, DEFAULT_OBJECTIVE_WEIGHTS)).rejects.toBeInstanceOf(Error);
  }, 30_000);

  it("handles concurrent runs and resolves each by id", async () => {
    const worker = makeWorkerOptimizer();
    try {
      const ref = runEpoch(EPOCH, INPUT, DEFAULT_OBJECTIVE_WEIGHTS);
      const [a, b, c] = await Promise.all([
        worker.run(EPOCH, INPUT, DEFAULT_OBJECTIVE_WEIGHTS),
        worker.run(EPOCH, INPUT, DEFAULT_OBJECTIVE_WEIGHTS),
        worker.run(EPOCH, INPUT, DEFAULT_OBJECTIVE_WEIGHTS),
      ]);
      expect(a).toEqual(ref);
      expect(b).toEqual(ref);
      expect(c).toEqual(ref);
    } finally {
      await worker.close();
    }
  }, 30_000);
});
