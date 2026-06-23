/**
 * `@mm/api` — the long-lived `worker_threads` optimizer CLIENT (spec §5).
 *
 * Spawns ONE worker at construction and reuses it for every job (no per-job spawn
 * cost). `run(epoch, input, weights)` posts a correlated request and resolves
 * with the matching `EpochResult`; `close()` terminates the worker and rejects
 * any in-flight requests. The returned `.run` IS a {@link RunEpochFn}, so it
 * drops straight into `RollingOptimizerService` (Task 5) — only the transport
 * differs from the inline path (DIP).
 *
 * MODULE RESOLUTION (the one subtle part): the worker must be a runnable `.js`.
 *  - BUILT mode (`dist/main.js`): the sibling `./optimizer-worker.js` exists next
 *    to this compiled file — resolve it directly.
 *  - VITEST src mode: `import.meta.url` points at the `.ts` source; the sibling
 *    `.js` does not exist, so we fall back to the package's built
 *    `dist/optimizer/optimizer-worker.js` (the gate runs `pnpm build` before the
 *    unit lane, so it is present). We pick the FIRST candidate that exists on
 *    disk — keeping it simple and correct in both runners.
 */

import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  Epoch,
  EpochInput,
  EpochResult,
  ObjectiveWeights,
} from "@mm/optimizer";
import type { RunEpochFn } from "./rolling-service.js";

/** The long-lived worker handle: a `RunEpochFn` plus a clean shutdown. */
export interface WorkerOptimizer {
  /** Post to the worker; resolves with the EpochResult (a `RunEpochFn`). */
  readonly run: RunEpochFn;
  /** Terminate the worker and reject any in-flight runs. */
  close(): Promise<void>;
}

/** The reply the worker posts back (discriminated on `ok`). */
type WorkerReply =
  | { readonly id: number; readonly ok: true; readonly result: EpochResult }
  | { readonly id: number; readonly ok: false; readonly error: string };

/** Resolve the runnable worker entry: built sibling first, else package `dist`. */
function resolveWorkerEntry(): string {
  const sibling = fileURLToPath(new URL("./optimizer-worker.js", import.meta.url));
  if (existsSync(sibling)) return sibling;
  const dist = fileURLToPath(
    new URL("../../dist/optimizer/optimizer-worker.js", import.meta.url),
  );
  if (existsSync(dist)) return dist;
  throw new Error(
    `optimizer-worker entry not found (looked at ${sibling} and ${dist}); ` +
      "run `pnpm build` so dist/optimizer/optimizer-worker.js exists",
  );
}

/**
 * Spawn ONE optimizer worker and return a {@link WorkerOptimizer}. The client
 * correlates replies by an incrementing id; a worker `error`/`exit` rejects all
 * pending requests so a caller never hangs.
 */
export function makeWorkerOptimizer(): WorkerOptimizer {
  const worker = new Worker(resolveWorkerEntry());
  const pending = new Map<number, {
    resolve: (r: EpochResult) => void;
    reject: (e: Error) => void;
  }>();
  let nextId = 0;
  let closed = false;

  function rejectAll(err: Error): void {
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  }

  worker.on("message", (reply: WorkerReply) => {
    const entry = pending.get(reply.id);
    if (entry === undefined) return; // stale/unknown id — ignore.
    pending.delete(reply.id);
    if (reply.ok) entry.resolve(reply.result);
    else entry.reject(new Error(reply.error));
  });
  worker.on("error", (err: Error) => {
    rejectAll(err);
  });
  worker.on("exit", (code: number) => {
    // A non-zero/early exit must not leave callers hanging.
    if (pending.size > 0) {
      rejectAll(new Error(`optimizer worker exited (code ${code}) with pending runs`));
    }
  });

  const run: RunEpochFn = (epoch: Epoch, input: EpochInput, weights: ObjectiveWeights) => {
    if (closed) {
      return Promise.reject(new Error("optimizer worker is closed"));
    }
    const id = nextId;
    nextId += 1;
    return new Promise<EpochResult>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, epoch, input, weights });
    });
  };

  return {
    run,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      rejectAll(new Error("optimizer worker is closing"));
      await worker.terminate();
    },
  };
}
