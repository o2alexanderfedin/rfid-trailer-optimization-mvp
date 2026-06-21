/**
 * `POST /sim/speed` + `GET /sim/speed` — the operator "speed of time" surface.
 *
 * The demo's playback speed is GLOBAL and server-authoritative (one
 * SpeedController; no per-client speed). The route validates a closed body with
 * a Fastify JSON schema (mirrors `scenario.ts`: `additionalProperties: false`,
 * numeric bounds), applies it to the injected controller, and replies the
 * effective {@link SimSpeedState}. The controller's `onChange` (wired in the
 * composition root) pushes an immediate ws envelope so a pause/speed change is
 * reflected on the map without waiting for a (possibly paused) next tick.
 *
 * Design (DIP / KISS):
 *  - The route does NOT pace the driver or broadcast directly — it mutates the
 *    pure controller; the driver reads `getTickIntervalMs()`/`isPaused()` and the
 *    snapshot builder stamps `snapshot()`.
 *  - DETERMINISM: speed/pause are presentation pacing only — they never enter the
 *    sim engine, the event store, or the optimizer.
 *
 * Threat model:
 *  - Tampering: the schema validates a closed `{ multiplier?, paused? }` shape;
 *    unknown fields rejected, `multiplier` bounded to [0.25, 8].
 *  - DoS: the bounded multiplier maps onto a clamped, non-zero tick interval
 *    ([62, 2000] ms) — no busy spin, no pathological pacing.
 */

import type { FastifyInstance } from "fastify";
import type { SimSpeedState } from "../ws/envelope.js";

// ---------------------------------------------------------------------------
// DIP port: the speed controller the route delegates to
// ---------------------------------------------------------------------------

/**
 * The minimal speed-controller surface the route needs (DIP). The real
 * {@link import("../sim/speed-controller.js").SpeedController} satisfies it; tests
 * inject a spy.
 */
export interface SimSpeedControllerPort {
  apply(input: { readonly multiplier?: number; readonly paused?: boolean }): void;
  snapshot(): SimSpeedState;
}

// ---------------------------------------------------------------------------
// Fastify JSON schema (closed shape, bounded multiplier)
// ---------------------------------------------------------------------------

/**
 * Strict, closed body schema. `additionalProperties: false` rejects unknown
 * fields; `multiplier` is bounded to the locked [0.25, 8] range (the controller
 * clamps too, but rejecting at the boundary gives a clear 400). `minProperties: 1`
 * requires at least one of `multiplier` / `paused`.
 */
const SIM_SPEED_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    multiplier: { type: "number", minimum: 0.25, maximum: 8 },
    paused: { type: "boolean" },
  },
} as const;

/** The SimSpeedState reply schema (documents the contract + serializes cleanly). */
const SIM_SPEED_REPLY_SCHEMA = {
  type: "object",
  properties: {
    multiplier: { type: "number" },
    tickIntervalMs: { type: "number" },
    simSpeed: { type: "number" },
    paused: { type: "boolean" },
  },
} as const;

interface SimSpeedBody {
  readonly multiplier?: number;
  readonly paused?: boolean;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register `GET /sim/speed` (current state) and `POST /sim/speed` (apply) on `app`.
 *
 * @param app        The Fastify instance.
 * @param controller The speed controller (DIP port). The route mutates it; the
 *                   controller's wired `onChange` triggers the immediate broadcast.
 */
export function registerSimSpeedRoutes(
  app: FastifyInstance,
  controller: SimSpeedControllerPort,
): void {
  app.get(
    "/sim/speed",
    { schema: { response: { 200: SIM_SPEED_REPLY_SCHEMA } } },
    (): SimSpeedState => controller.snapshot(),
  );

  app.post(
    "/sim/speed",
    {
      schema: {
        body: SIM_SPEED_BODY_SCHEMA,
        response: { 200: SIM_SPEED_REPLY_SCHEMA },
      },
    },
    (request): SimSpeedState => {
      const body = request.body as SimSpeedBody;
      const input: { multiplier?: number; paused?: boolean } = {};
      if (body.multiplier !== undefined) input.multiplier = body.multiplier;
      if (body.paused !== undefined) input.paused = body.paused;
      controller.apply(input);
      return controller.snapshot();
    },
  );
}
