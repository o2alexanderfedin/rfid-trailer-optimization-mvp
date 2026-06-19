/**
 * `POST /scenario` — the ONE operator mutation surface for SIM-04.
 *
 * Accepts the four scenario knobs (hub congestion, trip delay, demand spike,
 * sensor-noise level), validates them with a Fastify JSON schema (T-05-10:
 * closed shape, numeric bounds), then delegates to an injected
 * `ScenarioController` that hands the knobs to the running sim driver.
 *
 * Design (DIP / KISS):
 *  - The route does NOT write events directly — that is the sim/loop's job
 *    (T-05-12 auditability: the injection flows through the event store).
 *  - `ScenarioController` is the DIP port; the server composition root wires
 *    a real controller backed by the running sim; tests inject a mock.
 *  - Fastify JSON-schema validation enforces: additionalProperties=false,
 *    numeric bounds on factor/level/missRate, at-least-one-knob required (minProperties).
 *
 * Threat model:
 *  - T-05-10 (Tampering): Fastify schema validates the closed four-knob shape
 *    before any knob reaches the sim. Unknown/out-of-range knobs rejected 400.
 *  - T-05-11 (DoS): factor bound [1,10], level bound [0,1], delayMin bound [0,480],
 *    missRate bound [0,1] — bounded optimizer work per tick.
 *  - T-05-12 (Repudiation): the injection flows through the event store / sim stream.
 */

import type { FastifyInstance } from "fastify";
import type { ScenarioKnobs } from "@mm/simulation";

// ---------------------------------------------------------------------------
// DIP port: the scenario controller the route delegates to
// ---------------------------------------------------------------------------

/**
 * The scenario controller port. The route calls `injectScenario(knobs)`
 * and the implementation applies the knobs to the running sim driver.
 * Tests inject a mock; the server wires the real running-sim controller.
 */
export interface ScenarioController {
  injectScenario: (knobs: ScenarioKnobs) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Fastify JSON schema (T-05-10 / T-05-11)
// ---------------------------------------------------------------------------

/**
 * Strict, closed JSON schema for the POST body. `additionalProperties: false`
 * at the top level rejects unknown fields (T-05-10). Numeric bounds prevent
 * pathological inputs that could trigger unbounded optimizer work (T-05-11).
 * `minProperties: 1` ensures at least one knob is present (empty payload = 400).
 */
const SCENARIO_BODY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    hubCongestion: {
      type: "object",
      required: ["hubId", "level"],
      additionalProperties: false,
      properties: {
        hubId: { type: "string", minLength: 1 },
        level: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    tripDelay: {
      type: "object",
      required: ["routeId", "delayMin"],
      additionalProperties: false,
      properties: {
        routeId: { type: "string", minLength: 1 },
        delayMin: { type: "number", minimum: 0, maximum: 480 },
      },
    },
    demandSpike: {
      type: "object",
      required: ["hubId", "factor"],
      additionalProperties: false,
      properties: {
        hubId: { type: "string", minLength: 1 },
        factor: { type: "number", minimum: 1, maximum: 10 },
      },
    },
    sensorNoise: {
      type: "object",
      required: ["missRate", "rssiNoise"],
      additionalProperties: false,
      properties: {
        missRate: { type: "number", minimum: 0, maximum: 1 },
        rssiNoise: { type: "number", minimum: 0, maximum: 100 },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register `POST /scenario` on `app`.
 *
 * @param app        The Fastify instance to register on.
 * @param controller The scenario controller (DIP port) that applies knobs to
 *                   the running sim. Must not write events directly.
 */
export function registerScenarioRoutes(
  app: FastifyInstance,
  controller: ScenarioController,
): void {
  app.post(
    "/scenario",
    {
      schema: {
        body: SCENARIO_BODY_SCHEMA,
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
            },
          },
        },
      },
    },
    async (request): Promise<{ status: string }> => {
      const knobs = request.body as ScenarioKnobs;
      await controller.injectScenario(knobs);
      return { status: "applied" };
    },
  );
}
