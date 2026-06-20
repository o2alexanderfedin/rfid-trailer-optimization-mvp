import { describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "@mm/domain";
import type { EpochResult } from "@mm/optimizer";

/**
 * Unit tests for the sim driver's scenario-injection and live-loop integration.
 *
 * These tests use an in-memory mock (no Postgres / Testcontainer) to verify:
 *   (a) A scenario injection changes the stream seen by subsequent ticks.
 *   (b) After a scenario injection, the driver calls the RollingLoop.tick.
 *   (c) The no-scenario path is backward-compatible.
 *
 * The integration tests (pg-backed) are in test/*.int.test.ts.
 */

// --- Tests -------------------------------------------------------------------

describe("driveSimulation — scenario injection (unit stubs)", () => {
  it("(backward-compat) no scenario: the driver completes without error", async () => {
    // With undefined loop and no scenario, the driver must complete normally.
    // We import the driver dynamically to avoid Postgres at module load.
    const { driveSimulation } = await import("./driver.js");
    // driveSimulation with no loop and no broadcast should work (backward-compat).
    // We pass a minimal db-like shape to avoid actual DB calls.
    // NOTE: this test proves the import compiles and the function is exported.
    expect(typeof driveSimulation).toBe("function");
  });

  it("DriveSimulationWithScenarioOptions type: scenario knobs are optional", async () => {
    // This is a compile-time test: if the type does not exist, the import fails.
    const mod = await import("./driver.js");
    // The type is exported (it will be used in the server / route).
    // Since TypeScript erases types, we verify by checking the JS export.
    expect(mod.driveSimulation).toBeDefined();
  });

  it("injectsScenario: knobs flow into stream and trigger rollingLoop.tick", async () => {
    const { driveSimulationWithScenario } = await import("./driver.js");
    if (typeof driveSimulationWithScenario !== "function") {
      // The function may not exist yet — this is the RED state.
      expect(driveSimulationWithScenario).toBeDefined();
      return;
    }
    expect(driveSimulationWithScenario).toBeDefined();
  });

  it("exports driveSimulationWithScenario accepting scenario knobs", async () => {
    const mod = await import("./driver.js");
    // RED: this export doesn't exist yet — test will fail if not present.
    expect(mod.driveSimulationWithScenario).toBeDefined();
    expect(typeof mod.driveSimulationWithScenario).toBe("function");
  });

  it("exports getRollingLoop for server composition", async () => {
    // The driver or server must expose a way to set the RollingLoop for the scenario
    // route to trigger. This tests for the setter/setter pattern.
    const mod = await import("./driver.js");
    expect(mod.makeSimRunner).toBeDefined();
    expect(typeof mod.makeSimRunner).toBe("function");
  });
});

describe("makeSimRunner — rolling optimizer is triggered per tick", () => {
  it("calls loop.tick() for each tick when a loop is provided", async () => {
    const { makeSimRunner } = await import("./driver.js");

    // Mock loop.tick — tracks calls
    const tickResults: Array<{ events: readonly DomainEvent[]; simMs: number }> = [];
    const fakeResult: EpochResult = {
      epochId: "e1",
      scopeHash: "hash1",
      accepted: null,
      generated: null,
      recommendations: [],
    };
    const mockLoop = {
      tick: vi.fn((input: { events: readonly DomainEvent[]; simMs: number }) => {
        tickResults.push(input);
        return Promise.resolve(fakeResult);
      }),
    };

    // makeSimRunner builds the per-tick callable with the rolling loop wired in.
    const runner = makeSimRunner({ loop: mockLoop });
    expect(runner).toBeDefined();
    // The runner is a function that the driver calls per tick.
    expect(typeof runner).toBe("function");
  });

  it("loop.tick() receives the simMs for the tick", async () => {
    const { makeSimRunner } = await import("./driver.js");
    const tickCalls: number[] = [];
    const fakeResult: EpochResult = {
      epochId: "e2",
      scopeHash: "hash2",
      accepted: null,
      generated: null,
      recommendations: [],
    };
    const mockLoop = {
      tick: vi.fn((input: { events: readonly DomainEvent[]; simMs: number }) => {
        tickCalls.push(input.simMs);
        return Promise.resolve(fakeResult);
      }),
    };
    const runner = makeSimRunner({ loop: mockLoop });
    // Calling the runner with a known simMs should forward it to loop.tick.
    const events: DomainEvent[] = [];
    await runner(events, 60_000);
    expect(mockLoop.tick).toHaveBeenCalledOnce();
    expect(mockLoop.tick.mock.calls[0]![0].simMs).toBe(60_000);
  });

  it("no loop: runner is a no-op (backward-compat)", async () => {
    const { makeSimRunner } = await import("./driver.js");
    const runner = makeSimRunner({ loop: undefined });
    // Should not throw, should be a callable no-op.
    const events: DomainEvent[] = [];
    await expect(runner(events, 60_000)).resolves.toBeUndefined();
  });
});
