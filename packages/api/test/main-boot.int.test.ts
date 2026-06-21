import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { startPgFixture, type PgFixture } from "./pg-fixture.js";

/**
 * Regression test for the RUNNABLE entrypoint `main.ts` — the one the README's
 * "Run the full stack locally" path and the demo actually execute.
 *
 * The bug: `buildServer()` calls `await app.ready()`, so by the time `main.ts`
 * ran `app.addHook("onClose", ...)` the instance was already started and Fastify
 * threw `FST_ERR_INSTANCE_ALREADY_LISTENING` — the process crashed on EVERY boot
 * and never served a request. It was invisible to the rest of the suite because
 * every other integration test (and the real-e2e globalSetup) boots via
 * `buildServer()` directly + `app.inject()`, NEVER through `main()`.
 *
 * This test boots the ACTUAL compiled entrypoint (`dist/main.js`) as a child
 * process against a real Postgres, the same way an operator does, and asserts it
 * (1) listens and serves `/health` + projected `/hubs`, and (2) shuts down
 * cleanly (exit 0) on SIGTERM via the signal handler that replaced the hook.
 *
 * Pre-fix, the child exits 1 at startup → the health/exit race below trips the
 * "exited prematurely" branch and the test fails loudly with the captured
 * stderr (the Fastify error). Post-fix it serves and exits 0.
 */

const MAIN_JS = fileURLToPath(new URL("../dist/main.js", import.meta.url));

/** Allocate an ephemeral free TCP port for the spawned server. */
function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr: AddressInfo | string | null = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close(() => reject(new Error("could not allocate a free port")));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

/** True when `v` is a non-null object (lint-clean unknown narrowing, no `as`). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Poll `/health` until it returns `{ status: "ok" }` or the deadline elapses. */
async function waitForHealth(port: number, deadlineMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        const body: unknown = await res.json();
        if (isRecord(body) && body.status === "ok") return true;
      }
    } catch {
      // Not listening yet — retry until the deadline.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

describe("main.ts runnable entrypoint boots + serves + shuts down (regression: addHook-after-ready)", () => {
  let fx: PgFixture;
  let child: ChildProcess | undefined;
  let stderr = "";

  beforeAll(async () => {
    fx = await startPgFixture();
  }, 120_000);

  afterAll(async () => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await fx.stop();
  });

  it("listens, serves /health + projected /hubs, and exits 0 on SIGTERM", async () => {
    const port = await freePort();
    child = spawn(process.execPath, [MAIN_JS], {
      env: {
        ...process.env,
        DATABASE_URL: fx.connectionString,
        PORT: String(port),
        // Keep the boot fast: a tiny seeded baseline stream is enough to prove
        // the entrypoint wires the sim + projections without running for 60s.
        SIM_TICKS: "3",
        SIM_TICK_INTERVAL_MS: "20",
        SIM_SEED: "4242",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const exited = new Promise<number>((resolve) => {
      child?.once("exit", (code) => resolve(code ?? -1));
    });

    // Race: either /health comes up, or the process dies first (the pre-fix crash).
    const outcome = await Promise.race([
      waitForHealth(port, 30_000).then((ok) => ({ kind: "health" as const, ok })),
      exited.then((code) => ({ kind: "exit" as const, code })),
    ]);
    if (outcome.kind === "exit") {
      throw new Error(
        `main.ts exited prematurely with code ${outcome.code} before serving /health.\n--- child stderr ---\n${stderr}`,
      );
    }
    expect(outcome.ok, `main.ts never served /health in time.\n--- child stderr ---\n${stderr}`).toBe(true);

    // The live read API is wired against the real projected store.
    const hubsRes = await fetch(`http://127.0.0.1:${port}/hubs`);
    expect(hubsRes.status).toBe(200);
    const hubs: unknown = await hubsRes.json();
    expect(Array.isArray(hubs)).toBe(true);
    if (Array.isArray(hubs)) expect(hubs.length).toBeGreaterThan(0);

    // Clean shutdown: the SIGTERM handler closes the server + destroys the pool
    // and exits 0 (the behaviour that replaced the broken onClose hook).
    child.kill("SIGTERM");
    const code = await Promise.race([
      exited,
      new Promise<number>((resolve) => setTimeout(() => resolve(-2), 20_000)),
    ]);
    expect(code, `expected a clean exit 0 on SIGTERM (got ${code}).\n--- child stderr ---\n${stderr}`).toBe(0);
  }, 90_000);
});
