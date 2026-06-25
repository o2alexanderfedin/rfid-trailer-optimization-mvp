/**
 * `@mm/api` — the `worker_threads` OPTIMIZER WORKER entry (spec §5 Component B).
 *
 * Pure CPU only: it receives a serialized `{id, epoch, input, weights}` request,
 * runs the PURE `runEpoch` (the SAME compute the inline path runs — DIP, no logic
 * divergence), and posts `{id, ok:true, result}` back. On any throw it posts
 * `{id, ok:false, error}` so the client can reject the matching promise — the
 * worker NEVER crashes the thread on a bad request.
 *
 * BOUNDARY: NO DB, NO `Date.now()`, NO RNG here. `epoch.nowMin` is the sim-time
 * clock supplied by the main thread; all I/O (event-store append) stays on the
 * main thread (single writer). `epoch/input/weights/EpochResult` are plain data,
 * so the structured-clone transport over `postMessage` is lossless.
 *
 * This module compiles to `dist/optimizer/optimizer-worker.js` and is spawned by
 * {@link import("./worker-client.js").makeWorkerOptimizer}.
 */

import { parentPort } from "node:worker_threads";
import {
  runEpoch,
  type Epoch,
  type EpochInput,
  type ObjectiveWeights,
} from "@mm/optimizer";

/** A request posted by the client: a correlation id + the pure epoch inputs. */
interface WorkerRequest {
  readonly id: number;
  readonly epoch: Epoch;
  readonly input: EpochInput;
  readonly weights: ObjectiveWeights;
}

if (parentPort === null) {
  // Spawned with no parent port — nothing to serve. (Defensive; never expected.)
  throw new Error("optimizer-worker must run as a worker_threads worker");
}

const port = parentPort;
port.on("message", (msg: WorkerRequest) => {
  try {
    const result = runEpoch(msg.epoch, msg.input, msg.weights);
    port.postMessage({ id: msg.id, ok: true, result });
  } catch (err: unknown) {
    port.postMessage({ id: msg.id, ok: false, error: String(err) });
  }
});
