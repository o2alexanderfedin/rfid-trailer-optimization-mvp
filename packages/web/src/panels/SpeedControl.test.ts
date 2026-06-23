/**
 * SpeedControl gauge tests (TDD).
 *
 * Following the project's established panel pattern (KpiDashboard, AlertFeed),
 * the gauge's business logic lives in PURE exported helpers tested in Node — the
 * component itself is a thin shell over them. The repo's vitest unit project only
 * runs `*.test.ts` (not `.tsx`) and has no jsdom, so we exercise:
 *   - the log-scale slider math (the slider→multiplier the POST sends),
 *   - the readout string the gauge renders (slider + readout),
 *   - the envelope-speed change guard (server-confirmed display, per-tick noise
 *     suppressed),
 *   - the pause/resume input the button POSTs.
 */
import { describe, expect, it } from "vitest";
import {
  multiplierToSlider,
  sliderToMultiplier,
  formatReadout,
  speedChanged,
  MIN_MULTIPLIER,
  MAX_MULTIPLIER,
  SLIDER_MIN,
  SLIDER_MAX,
  DEFAULT_SPEED,
} from "./SpeedControl.js";
import type { SimSpeedState } from "../api/client.js";

// ---------------------------------------------------------------------------
// log-scale slider math (the value the slider posts as a multiplier)
// ---------------------------------------------------------------------------

describe("slider ⇆ multiplier (log2 mapping)", () => {
  it("1× sits at slider value 0 (log2(1))", () => {
    expect(multiplierToSlider(1)).toBe(0);
    expect(sliderToMultiplier(0)).toBe(1);
  });

  it("maps the bounds onto the slider domain [-2, 6]", () => {
    expect(SLIDER_MIN).toBe(-2); // log2(0.25)
    expect(SLIDER_MAX).toBe(6); //  log2(64)
    expect(sliderToMultiplier(SLIDER_MIN)).toBeCloseTo(MIN_MULTIPLIER);
    expect(sliderToMultiplier(SLIDER_MAX)).toBeCloseTo(MAX_MULTIPLIER); // 64×
  });

  it("round-trips a multiplier through the slider value", () => {
    for (const m of [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64]) {
      expect(sliderToMultiplier(multiplierToSlider(m))).toBeCloseTo(m);
    }
  });

  it("doubling the slider step doubles the multiplier (even log spacing)", () => {
    // +1 in log2 space = ×2 multiplier.
    expect(sliderToMultiplier(1)).toBeCloseTo(2);
    expect(sliderToMultiplier(2)).toBeCloseTo(4);
    expect(sliderToMultiplier(-1)).toBeCloseTo(0.5);
  });

  it("clamps out-of-range slider/multiplier inputs to the bounds", () => {
    expect(sliderToMultiplier(10)).toBe(MAX_MULTIPLIER); // way past 3
    expect(sliderToMultiplier(-10)).toBe(MIN_MULTIPLIER); // way past -2
    expect(multiplierToSlider(100)).toBe(SLIDER_MAX);
    expect(multiplierToSlider(0.001)).toBe(SLIDER_MIN);
  });
});

// ---------------------------------------------------------------------------
// readout string (slider + sim-min/real-sec)
// ---------------------------------------------------------------------------

describe("formatReadout — the gauge's displayed string", () => {
  it("renders the 1× default as ~2 sim-min/real-sec (500ms tick)", () => {
    expect(formatReadout(1, 500)).toBe("1.00× · ~2 sim-min/real-sec");
  });

  it("renders 2× as ~4 sim-min/real-sec (250ms tick)", () => {
    expect(formatReadout(2, 250)).toBe("2.00× · ~4 sim-min/real-sec");
  });

  it("renders 8× as ~16 sim-min/real-sec (62ms tick)", () => {
    expect(formatReadout(8, 62)).toBe("8.00× · ~16 sim-min/real-sec");
  });

  it("renders 0.25× as ~1 sim-min/real-sec (2000ms tick)", () => {
    expect(formatReadout(0.25, 2000)).toBe("0.25× · ~1 sim-min/real-sec");
  });
});

// ---------------------------------------------------------------------------
// envelope-speed change guard (server-confirmed display, no per-tick re-render)
// ---------------------------------------------------------------------------

describe("speedChanged — only re-render when the speed actually changes", () => {
  const base: SimSpeedState = DEFAULT_SPEED;

  it("is false for an identical speed (a per-tick envelope with unchanged speed)", () => {
    expect(speedChanged(base, { ...base })).toBe(false);
  });

  it("is true when any field changes (multiplier / interval / simSpeed / paused)", () => {
    expect(speedChanged(base, { ...base, multiplier: 2 })).toBe(true);
    expect(speedChanged(base, { ...base, tickIntervalMs: 250 })).toBe(true);
    expect(speedChanged(base, { ...base, simSpeed: 0 })).toBe(true);
    expect(speedChanged(base, { ...base, paused: true })).toBe(true);
  });

  it("reflects a server pause (simSpeed → 0) as a change", () => {
    const paused: SimSpeedState = {
      multiplier: 1,
      tickIntervalMs: 500,
      simSpeed: 0,
      paused: true,
    };
    expect(speedChanged(base, paused)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// default state (before the first envelope)
// ---------------------------------------------------------------------------

describe("DEFAULT_SPEED — the pre-envelope display", () => {
  it("is the 1× / 120 sim-speed state", () => {
    expect(DEFAULT_SPEED).toEqual({
      multiplier: 1,
      tickIntervalMs: 500,
      simSpeed: 120,
      paused: false,
    });
  });
});
