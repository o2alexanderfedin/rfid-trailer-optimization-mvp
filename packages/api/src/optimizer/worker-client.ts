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
import { AsyncQueue } from "@alexanderfedin/async-queue";

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

/**
 * A queued optimizer request — the message shape posted to the worker.
 * Typed concretely (never `any`) per PERF-03 constraint.
 */
interface WorkerRequest {
  readonly id: number;
  readonly epoch: Epoch;
  readonly input: EpochInput;
  readonly weights: ObjectiveWeights;
}

/**
 * Max number of optimizer requests that can be in-flight concurrently.
 * The live-loop only ever needs 1–2 outstanding epochs; 4 gives a small burst
 * budget while keeping memory bounded (PERF-03 / T-27-13).
 */
const WORKER_QUEUE_MAX_SIZE = 4;

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
 *
 * PERF-03 (seam a): the previously-unbounded `pending` Map / direct `postMessage`
 * is replaced by a bounded `AsyncQueue<WorkerRequest>`. The `run` function enqueues
 * the request (blocking the caller when `WORKER_QUEUE_MAX_SIZE` requests are
 * already in-flight) and a single consumer pump dequeues + `postMessage`s them in
 * FIFO order. This bounds the number of in-flight epochs to `WORKER_QUEUE_MAX_SIZE`
 * without reordering requests (T-27-13).
 *
 * The `pending` Map is still used for reply-correlation (resolving by `reply.id`),
 * and `rejectAll` still drains it on error/exit so callers never hang.
 */
export function makeWorkerOptimizer(): WorkerOptimizer {
  const worker = new Worker(resolveWorkerEntry());
  const pending = new Map<number, {
    resolve: (r: EpochResult) => void;
    reject: (e: Error) => void;
  }>();
  let nextId = 0;
  let closed = false;

  // Bounded FIFO queue: backpressures the live-loop when WORKER_QUEUE_MAX_SIZE
  // requests are already queued / in-flight (T-27-13).
  const requestQueue = new AsyncQueue<WorkerRequest>(WORKER_QUEUE_MAX_SIZE);

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
    requestQueue.close(); // wake any blocked enqueue callers
    rejectAll(err);
  });
  worker.on("exit", (code: number) => {
    requestQueue.close(); // wake any blocked enqueue callers
    // A non-zero/early exit must not leave callers hanging.
    if (pending.size > 0) {
      rejectAll(new Error(`optimizer worker exited (code ${code}) with pending runs`));
    }
  });

  // Consumer pump: dequeues requests from the bounded queue and postMessages them
  // to the worker in FIFO order. Exits cleanly when the queue is closed + drained.
  (async () => {
    for await (const req of requestQueue) {
      // After close() the worker is being terminated; skip posting stale requests.
      if (closed) break;
      worker.postMessage(req);
    }
  })().catch(() => {
    // Pump error (e.g. close while iterating) — rejectAll is handled by the
    // error/exit handlers above; nothing extra needed here.
  });

  const run: RunEpochFn = (epoch: Epoch, input: EpochInput, weights: ObjectiveWeights) => {
    if (closed) {
      return Promise.reject(new Error("optimizer worker is closed"));
    }
    const id = nextId;
    nextId += 1;
    return new Promise<EpochResult>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      // Enqueue the request (may block/backpressure when queue is full).
      requestQueue.enqueue({ id, epoch, input, weights }).catch((err: unknown) => {
        // If the queue was closed before we could enqueue (e.g. rapid close()),
        // reject the pending entry so the caller doesn't hang.
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  };

  return {
    run,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // CR-02: close the queue FIRST (wakes any blocked enqueue callers; they
      // check `closed` and throw, then their `.catch()` removes the entry from
      // `pending` and rejects the caller's Promise). THEN await termination so
      // any in-flight replies drain. THEN rejectAll for entries that survived
      // (i.e. requests already dequeued + postMessage'd but not yet replied).
      // This ordering is unambiguous: a given `pending` entry is rejected by
      // exactly ONE path — either the enqueue `.catch()` (queue-full/close path)
      // OR rejectAll (post-send/no-reply path) — never both.
      requestQueue.close(); // stop accepting new requests; wake blocked enqueuers
      await worker.terminate();
      rejectAll(new Error("optimizer worker is closing"));
    },
  };
}
