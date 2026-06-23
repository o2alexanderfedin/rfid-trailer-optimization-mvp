/**
 * Unit tests for the pure SpeedController (TDD RED → GREEN).
 *
 * The controller is the single source of truth for the demo's "speed of time":
 * it maps a user-facing multiplier (relative to the default 1×) onto the
 * presentation-layer `tickIntervalMs` the paced driver waits between ticks, and
 * derives the frontend playback rate `simSpeed = msPerTick / tickIntervalMs`
 * (0 when paused). It is PURE state — no I/O, no timers — so the driver, the
 * broadcast, and the POST route all read from one consistent snapshot.
 *
 * Speed model (locked):
 *   - default tickIntervalMs = 500 ⇒ multiplier 1.
 *   - multiplier m: tickIntervalMs = round(500 / m), m clamped to [0.25, 8],
 *     interval clamped to [62, 2000] (never 0).
 *   - simSpeed = 60000 / tickIntervalMs, but 0 while paused.
 *   - multiplier reported = 500 / tickIntervalMs.
 */

import { describe, expect, it, vi } from "vitest";
import { makeSpeedController } from "./speed-controller.js";

describe("makeSpeedController — multiplier ⇆ tickInterval mapping", () => {
  it("defaults to 1× (tickIntervalMs=500, simSpeed=120, not paused)", () => {
    const c = makeSpeedController();
    const s = c.snapshot();
    expect(s.tickIntervalMs).toBe(500);
    expect(s.multiplier).toBe(1);
    expect(s.simSpeed).toBe(120); // 60000 / 500
    expect(s.paused).toBe(false);
    expect(c.getTickIntervalMs()).toBe(500);
    expect(c.isPaused()).toBe(false);
    expect(c.getSimSpeed()).toBe(120);
  });

  it("m=2 ⇒ tickIntervalMs=250, simSpeed=240", () => {
    const c = makeSpeedController();
    c.setMultiplier(2);
    expect(c.getTickIntervalMs()).toBe(250); // round(500/2)
    expect(c.getSimSpeed()).toBe(240); // 60000/250
    expect(c.snapshot().multiplier).toBe(2); // 500/250
  });

  it("m=0.5 ⇒ tickIntervalMs=1000, simSpeed=60", () => {
    const c = makeSpeedController();
    c.setMultiplier(0.5);
    expect(c.getTickIntervalMs()).toBe(1000); // round(500/0.5)
    expect(c.getSimSpeed()).toBe(60); // 60000/1000
    expect(c.snapshot().multiplier).toBe(0.5);
  });

  it("m=8 (max) ⇒ tickIntervalMs=62 (clamped interval), never below the floor", () => {
    const c = makeSpeedController();
    c.setMultiplier(8);
    // round(500/8) = 63, but the interval floor is 62; either way it is >= 62.
    expect(c.getTickIntervalMs()).toBeGreaterThanOrEqual(62);
    expect(c.getTickIntervalMs()).toBeLessThanOrEqual(63);
    expect(c.getSimSpeed()).toBeGreaterThan(900);
  });

  it("m=0.25 (min) ⇒ tickIntervalMs=2000 (interval ceiling)", () => {
    const c = makeSpeedController();
    c.setMultiplier(0.25);
    expect(c.getTickIntervalMs()).toBe(2000); // round(500/0.25)
    expect(c.getSimSpeed()).toBe(30); // 60000/2000
  });
});

describe("makeSpeedController — multiplier clamping (out of range)", () => {
  it("clamps a multiplier above 64 to the 64× interval", () => {
    const c = makeSpeedController();
    c.setMultiplier(100);
    const atMax = makeSpeedController();
    atMax.setMultiplier(64);
    expect(c.getTickIntervalMs()).toBe(atMax.getTickIntervalMs());
  });

  it("m=64 (max) ⇒ exact 64× (tickIntervalMs=7.8125, simSpeed=7680)", () => {
    const c = makeSpeedController();
    c.setMultiplier(64);
    expect(c.getTickIntervalMs()).toBeCloseTo(500 / 64); // 7.8125 — not floored
    expect(c.snapshot().multiplier).toBeCloseTo(64); // exact, not 62.5
    expect(c.getSimSpeed()).toBeCloseTo(60_000 / (500 / 64)); // 7680
  });

  it("clamps a multiplier below 0.25 to the 0.25× interval", () => {
    const c = makeSpeedController();
    c.setMultiplier(0.001);
    expect(c.getTickIntervalMs()).toBe(2000); // == 0.25× interval
  });

  it("never yields a zero interval (avoids a busy spin in the driver)", () => {
    const c = makeSpeedController();
    c.setMultiplier(1_000_000);
    expect(c.getTickIntervalMs()).toBeGreaterThan(0);
  });
});

describe("makeSpeedController — pause semantics", () => {
  it("paused ⇒ simSpeed is 0 but the tickIntervalMs (cadence target) is unchanged", () => {
    const c = makeSpeedController();
    c.setMultiplier(2); // interval 250
    c.setPaused(true);
    expect(c.isPaused()).toBe(true);
    expect(c.getSimSpeed()).toBe(0); // frozen tween
    expect(c.snapshot().simSpeed).toBe(0);
    // The interval is retained so resuming restores the prior speed.
    expect(c.getTickIntervalMs()).toBe(250);
    expect(c.snapshot().tickIntervalMs).toBe(250);
  });

  it("resuming restores simSpeed from the retained interval", () => {
    const c = makeSpeedController();
    c.setMultiplier(2);
    c.setPaused(true);
    expect(c.getSimSpeed()).toBe(0);
    c.setPaused(false);
    expect(c.getSimSpeed()).toBe(240); // back to 60000/250
  });
});

describe("makeSpeedController — apply({multiplier?, paused?})", () => {
  it("applies both multiplier and paused atomically", () => {
    const c = makeSpeedController();
    c.apply({ multiplier: 4, paused: true });
    expect(c.getTickIntervalMs()).toBe(125); // round(500/4)
    expect(c.isPaused()).toBe(true);
    expect(c.getSimSpeed()).toBe(0);
    const s = c.snapshot();
    expect(s.multiplier).toBe(4);
  });

  it("applies only the provided fields (omitted fields unchanged)", () => {
    const c = makeSpeedController();
    c.setMultiplier(2);
    c.apply({ paused: true }); // multiplier untouched
    expect(c.getTickIntervalMs()).toBe(250);
    expect(c.isPaused()).toBe(true);
    c.apply({ multiplier: 1 }); // paused untouched
    expect(c.isPaused()).toBe(true);
    expect(c.getTickIntervalMs()).toBe(500);
  });
});

describe("makeSpeedController — lastSimMs tracking + onChange", () => {
  it("noteSimMs records the latest authoritative sim time for immediate broadcasts", () => {
    const c = makeSpeedController();
    expect(c.getLastSimMs()).toBe(0);
    c.noteSimMs(120_000);
    expect(c.getLastSimMs()).toBe(120_000);
  });

  it("fires onChange(snapshot) after every mutator (setMultiplier/setPaused/apply)", () => {
    const seen: number[] = [];
    const c = makeSpeedController({
      onChange: (snap) => seen.push(snap.tickIntervalMs),
    });
    c.setMultiplier(2);
    c.setPaused(true);
    c.apply({ multiplier: 1, paused: false });
    // Three mutating calls → three onChange fires, each with the post-mutation snapshot.
    expect(seen).toEqual([250, 250, 500]);
  });

  it("does NOT fire onChange from noteSimMs (pacing bookkeeping, not a state change)", () => {
    const onChange = vi.fn();
    const c = makeSpeedController({ onChange });
    c.noteSimMs(60_000);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("makeSpeedController — snapshot shape (the wire contract)", () => {
  it("snapshot carries exactly { multiplier, tickIntervalMs, simSpeed, paused }", () => {
    const c = makeSpeedController();
    const s = c.snapshot();
    expect(Object.keys(s).sort()).toEqual(
      ["multiplier", "paused", "simSpeed", "tickIntervalMs"].sort(),
    );
  });
});
