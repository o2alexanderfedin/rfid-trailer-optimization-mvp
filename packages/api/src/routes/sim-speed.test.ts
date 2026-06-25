/**
 * Unit tests for the `POST /sim/speed` + `GET /sim/speed` route.
 *
 * In-process Fastify with a real (pure) SpeedController wired to an `onChange`
 * spy — no Postgres. They verify:
 *   - GET returns the current effective state.
 *   - POST applies a valid multiplier (sets the interval) and replies the state.
 *   - POST clamps / rejects out-of-range multipliers (schema bound).
 *   - POST toggles pause (simSpeed → 0).
 *   - POST triggers an immediate broadcast via the controller's onChange.
 *   - The reply shape is the SimSpeedState contract.
 */

import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerSimSpeedRoutes } from "./sim-speed.js";
import { makeSpeedController } from "../sim/speed-controller.js";
import type { SimSpeedState } from "../ws/envelope.js";

/** Build a Fastify app with the route + a controller whose onChange is spied. */
async function buildTestApp() {
  const onChange = vi.fn<(s: SimSpeedState) => void>();
  const controller = makeSpeedController({ onChange });
  const app = Fastify({ logger: false });
  registerSimSpeedRoutes(app, controller);
  await app.ready();
  return { app, controller, onChange };
}

describe("GET /sim/speed", () => {
  it("returns the current effective speed state (default 1×)", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({ method: "GET", url: "/sim/speed" });
      expect(res.statusCode).toBe(200);
      expect(res.json<SimSpeedState>()).toEqual({
        multiplier: 1,
        tickIntervalMs: 500,
        simSpeed: 120,
        paused: false,
      });
    } finally {
      await app.close();
    }
  });
});

describe("POST /sim/speed — validation + apply", () => {
  it("applies a valid multiplier and replies the effective state", async () => {
    const { app, controller } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sim/speed",
        payload: { multiplier: 2 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<SimSpeedState>();
      expect(body.tickIntervalMs).toBe(250); // round(500/2)
      expect(body.simSpeed).toBe(240);
      expect(body.multiplier).toBe(2);
      // The controller now reflects the applied speed.
      expect(controller.getTickIntervalMs()).toBe(250);
    } finally {
      await app.close();
    }
  });

  it("toggles pause: simSpeed drops to 0, interval retained", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sim/speed",
        payload: { paused: true },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<SimSpeedState>();
      expect(body.paused).toBe(true);
      expect(body.simSpeed).toBe(0);
      expect(body.tickIntervalMs).toBe(500);
    } finally {
      await app.close();
    }
  });

  it("applies multiplier + paused together", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sim/speed",
        payload: { multiplier: 4, paused: true },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<SimSpeedState>();
      expect(body.tickIntervalMs).toBe(125); // round(500/4)
      expect(body.paused).toBe(true);
      expect(body.simSpeed).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("accepts the 64× max multiplier", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sim/speed",
        payload: { multiplier: 64 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { multiplier: number };
      expect(body.multiplier).toBeCloseTo(64);
    } finally {
      await app.close();
    }
  });

  it("rejects a multiplier above the 64× bound (400)", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sim/speed",
        payload: { multiplier: 128 },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("rejects a multiplier below the 0.25× bound (400)", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sim/speed",
        payload: { multiplier: 0.1 },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("rejects an empty body (at least one of multiplier/paused required)", async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/sim/speed",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("triggers an immediate broadcast via the controller onChange", async () => {
    const { app, onChange } = await buildTestApp();
    try {
      await app.inject({
        method: "POST",
        url: "/sim/speed",
        payload: { multiplier: 2 },
      });
      // The controller fired onChange exactly once with the post-apply snapshot —
      // the composition root wires this to broadcast(getLastSimMs()).
      expect(onChange).toHaveBeenCalledOnce();
      expect(onChange.mock.calls[0]![0].tickIntervalMs).toBe(250);
    } finally {
      await app.close();
    }
  });
});
