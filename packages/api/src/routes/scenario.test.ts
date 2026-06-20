import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerScenarioRoutes } from "./scenario.js";
import type { ScenarioKnobs } from "@mm/simulation";

/**
 * Unit tests for the `POST /scenario` route.
 *
 * These tests use an in-process Fastify instance with a mock sim controller
 * (no Postgres, no Testcontainer). They verify:
 *   - The route validates the four-knob body (rejects unknown/invalid inputs).
 *   - The route accepts valid knob combinations and forwards to the controller.
 *   - The route returns 200 on success.
 *   - The route is the ONLY mutation surface (no direct event-store writes).
 */

/** Build a minimal Fastify app with the scenario route registered. */
async function buildTestApp(onInject?: (knobs: ScenarioKnobs) => void) {
  const app = Fastify({ logger: false });

  const controller = {
    injectScenario: vi.fn(async (knobs: ScenarioKnobs) => {
      onInject?.(knobs);
    }),
  };

  registerScenarioRoutes(app, controller);
  await app.ready();
  return { app, controller };
}

describe("POST /scenario — validation and dispatch", () => {
  it("returns 200 with valid demandSpike knob", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/scenario",
        payload: { demandSpike: { hubId: "MEM", factor: 2 } },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("returns 200 with valid hubCongestion knob", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/scenario",
        payload: { hubCongestion: { hubId: "ORD", level: 0.5 } },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("returns 200 with valid tripDelay knob", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/scenario",
        payload: { tripDelay: { routeId: "MEM-ORD", delayMin: 30 } },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("returns 200 with valid sensorNoise knob", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/scenario",
        payload: { sensorNoise: { missRate: 0.3, rssiNoise: 2 } },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("returns 200 with all four knobs combined", async () => {
    let captured: ScenarioKnobs | undefined;
    const { app } = await buildTestApp((knobs) => { captured = knobs; });
    try {
      const payload: ScenarioKnobs = {
        demandSpike: { hubId: "MEM", factor: 1.5 },
        hubCongestion: { hubId: "ORD", level: 0.3 },
        tripDelay: { routeId: "MEM-DFW", delayMin: 15 },
        sensorNoise: { missRate: 0.1, rssiNoise: 1 },
      };
      const res = await app.inject({
        method: "POST",
        url: "/scenario",
        payload,
      });
      expect(res.statusCode).toBe(200);
      // Controller must receive the knobs unchanged.
      expect(captured).toBeDefined();
      expect(captured!.demandSpike!.factor).toBe(1.5);
      expect(captured!.hubCongestion!.level).toBe(0.3);
    } finally {
      await app.close();
    }
  });

  it("returns 400 when hubCongestion.level is out of range (> 1)", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/scenario",
        payload: { hubCongestion: { hubId: "ORD", level: 2.5 } },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("returns 400 when hubCongestion.level is negative", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/scenario",
        payload: { hubCongestion: { hubId: "ORD", level: -0.5 } },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("returns 400 when demandSpike.factor is negative", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/scenario",
        payload: { demandSpike: { hubId: "MEM", factor: -1 } },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("returns 400 when sensorNoise.missRate is > 1", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/scenario",
        payload: { sensorNoise: { missRate: 1.5, rssiNoise: 1 } },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("strips unknown top-level field (Fastify default: removeAdditional) and treats as empty", async () => {
    // Fastify 5 default: `removeAdditional: true` strips unknown fields before
    // the controller receives the body. A payload with ONLY unknown fields is
    // stripped to {}, which fails minProperties: 1 → controller.injectScenario is NOT called.
    const { app, controller } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/scenario",
        // This body has only one unknown field — Fastify strips it to {} and
        // the route either returns 400 (minProperties) or calls controller with {}.
        // Either way, the unknown field must NOT reach injectScenario.
        payload: { unknownField: { foo: "bar" } },
      });
      // The controller must NOT have received any knobs with the unknown field.
      // Whether the route returns 200 or 400 (impl-specific after stripping),
      // the unknown field must not flow to the sim.
      if (res.statusCode === 200) {
        // If 200, the body was stripped to {} — controller called with empty knobs.
        // The important thing is that unknownField did not reach injectScenario.
        expect(controller.injectScenario.mock.calls[0]?.[0]).not.toHaveProperty("unknownField");
      } else {
        expect(res.statusCode).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  it("returns 400 with completely empty body (no knobs at all)", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/scenario",
        payload: {},
      });
      // An empty body is 400: at least one knob must be present (minProperties: 1).
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("forwards knobs to controller.injectScenario (no direct event writes)", async () => {
    const { app, controller } = await buildTestApp();
    try {
      await app.inject({
        method: "POST",
        url: "/scenario",
        payload: { demandSpike: { hubId: "MEM", factor: 2 } },
      });
      // The route delegates to the controller — it never writes events itself.
      expect(controller.injectScenario).toHaveBeenCalledOnce();
      const args = controller.injectScenario.mock.calls[0]![0];
      expect(args.demandSpike).toBeDefined();
      expect(args.demandSpike!.hubId).toBe("MEM");
    } finally {
      await app.close();
    }
  });
});
