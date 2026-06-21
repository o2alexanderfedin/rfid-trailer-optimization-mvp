import Fastify, { type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@mm/event-store";
import fastifyWebsocket from "@fastify/websocket";
import { registerQueryRoutes, type ApiDb } from "./routes/queries.js";
import { registerExceptionRoutes } from "./routes/exceptions.js";
import { registerPlanRoutes } from "./routes/plan.js";
import { registerPlanDetailRoutes } from "./routes/plan-detail.js";
import { registerOptimizerRoutes } from "./routes/optimizer.js";
import { registerKpiRoutes } from "./routes/kpis.js";
import { registerScenarioRoutes } from "./routes/scenario.js";
import { RollingOptimizerService } from "./optimizer/rolling-service.js";
import { RollingLoop } from "./optimizer/live-loop.js";
import { buildTwinSnapshot } from "./optimizer/twin-snapshot.js";
import { attachSnapshotSocket, type Broadcast } from "./ws/snapshots.js";
import { SimController } from "./sim/sim-controller.js";
import { makeSpeedController, type SpeedController } from "./sim/speed-controller.js";
import type { SnapshotDb } from "./optimizer/twin-snapshot.js";

/**
 * The composition root: builds the full Fastify query API (FND-05/06/07/08) plus
 * the ws snapshot channel, wired to a single Kysely handle that owns the event
 * store + projection tables. Kept a factory (no global state) so integration
 * tests `app.inject()` / connect a ws client against a Testcontainer, and the
 * runnable entrypoint (`main.ts`) passes a live connection.
 *
 * SIM-04 additions (Plan 05-05):
 *  - `RollingLoop` is built and wired so the live optimizer runs per tick.
 *  - `SimController` is built and wired to `POST /scenario`.
 *  - Both are returned in `BuiltServer` for the sim driver (`main.ts`).
 *
 * This SUPERSEDES the Plan 01 skeleton server: `GET /hubs` is preserved (now
 * served from the projected `hubs` table), and the FND query + ws surfaces are
 * added. The API is the ONLY package wiring concrete infrastructure together,
 * keeping the lower packages free of HTTP/process concerns.
 */

/** Dependencies for {@link buildServer}: the composition-root DB handle. */
export interface ServerDeps {
  readonly db: ApiDb;
  /** Toggle the realtime ws channel (default true). */
  readonly enableWs?: boolean;
  /**
   * SIM-04: how many ticks to drive during a scenario re-opt (default 5).
   * A short window triggers one optimizer epoch and returns recommendations.
   */
  readonly scenarioReoptTicks?: number;
  /**
   * SIM-04: the base seed to use for scenario re-opt runs (default 4242).
   * Must match the seed used by the initial `driveSimulation` call in `main.ts`.
   */
  readonly simSeed?: number;
  /**
   * FIX F: the total number of ticks the initial baseline sim was driven for.
   * Passed to `SimController` so scenario injection computes `scenarioEpochMs`
   * from the FULL baseline stream end, ensuring the scenario optimizer epoch is
   * strictly beyond any baseline epoch already memoized by the optimizer.
   *
   * Must match `SIM_TICKS` / `durationTicks` used in `main.ts`. Default: 120.
   */
  readonly baselineTicks?: number;
}

/** The built server plus the per-tick snapshot `broadcast` (when ws is enabled). */
export interface BuiltServer {
  readonly app: FastifyInstance;
  /** Push one batched snapshot to every ws client; `undefined` when ws is off. */
  readonly broadcast: Broadcast | undefined;
  /** The rolling optimizer shell (OPT-04/05/06) — the only stateful writer. */
  readonly optimizer: RollingOptimizerService;
  /**
   * SIM-04: The live rolling-optimizer loop (wraps the optimizer service + snapshot).
   * The sim driver calls `loop.tick(...)` per tick. Exposed for `main.ts` wiring.
   */
  readonly loop: RollingLoop;
  /**
   * SIM-04: The scenario controller (injected into `POST /scenario`).
   * The sim driver gets the loop from the server so that `driveSimulation`
   * can call `loop.tick()` per tick and produce live recommendations.
   */
  readonly simController: SimController;
}

/** Build the Fastify server (REST query routes + optional ws snapshots). */
export async function buildServer(deps: ServerDeps): Promise<BuiltServer> {
  const app = Fastify({ logger: false });

  // Minimal permissive CORS for the local demo (Vite dev origin / e2e).
  app.addHook("onRequest", (_req, reply, done) => {
    reply.header("access-control-allow-origin", "*");
    done();
  });

  app.get("/health", () => ({ status: "ok" }));
  registerQueryRoutes(app, deps.db);
  // Phase 3 (SNS-04/05): the exception feed + FP-rate KPI + zone-estimate query.
  registerExceptionRoutes(app, deps.db);
  // POST /plan — the pure load-planning pipeline (LOAD-08). Read-only, DB-free.
  registerPlanRoutes(app);
  // Plan 05-04: GET /trailers/:id/plan (VIZ-05) + GET /trailers/:id/history (UI-02).
  registerPlanDetailRoutes(app, deps.db);
  // The rolling optimizer shell (OPT-04/05/06) + its read-only recommendations
  // endpoint. The service owns the ONE write path (PlanAccepted); the route reads.
  // The optimizer only appends to the event store, so it views the handle as the
  // event-store schema (the same narrowing the sim driver uses).
  const optimizer = new RollingOptimizerService({
    db: deps.db as unknown as Kysely<Database>,
  });
  registerOptimizerRoutes(app, optimizer);

  // Plan 05-03 / Plan 05-05 (live wiring): GET /kpis + GET /kpis/comparison.
  // Pass `optimizer` so the KPI endpoint can read the latest rolling-epoch result
  // for the rehandle score (SIM-04 critical live wiring).
  registerKpiRoutes(app, deps.db, optimizer);

  // SIM-04 / OPT-02: The live rolling-optimizer loop (Plan 05-02).
  // `buildSnapshot` reads the current live projections to assemble the TwinSnapshot.
  // The sim driver calls `loop.tick(...)` per tick so the optimizer runs live.
  const snapshotDb: SnapshotDb = deps.db;
  const loop = new RollingLoop({
    service: optimizer,
    buildSnapshot: () => buildTwinSnapshot(snapshotDb),
    freezeWindowMin: 15,
  });

  // ONE SpeedController seeded from the env default tick interval (1× by
  // default). `onChange` pushes an immediate envelope so a pause/speed POST
  // reflects without waiting for a (possibly paused) next tick — simSpeed:0 on
  // pause. `broadcast` is assigned just below; the closure reads it lazily.
  let broadcast: Broadcast | undefined;
  const defaultIntervalMs = Number(process.env.SIM_TICK_INTERVAL_MS ?? 500);
  const speedController: SpeedController = makeSpeedController({
    defaultIntervalMs,
    onChange: () => {
      void broadcast?.(speedController.getLastSimMs());
    },
  });

  if (deps.enableWs ?? true) {
    await app.register(fastifyWebsocket);
    broadcast = attachSnapshotSocket(app, deps.db, speedController);
  }

  // SIM-04: The scenario controller — wires `POST /scenario` to a short
  // scenario re-opt run using the live loop + broadcast.
  const simSeed = deps.simSeed ?? 4242;
  const reoptTicks = deps.scenarioReoptTicks ?? 5;
  // FIX F: pass the full baseline tick count so scenario injection computes
  // scenarioEpochMs beyond any already-memoized baseline epoch.
  const baselineTicks = deps.baselineTicks ?? 120;
  const simController = new SimController({
    db: deps.db,
    seed: simSeed,
    reoptTicks,
    baselineTicks,
    loop,
    broadcast,
  });
  registerScenarioRoutes(app, simController);

  await app.ready();
  return { app, broadcast, optimizer, loop, simController };
}
