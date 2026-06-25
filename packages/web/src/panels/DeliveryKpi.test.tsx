/**
 * DeliveryKpi tests (OUT-05, P2) — pure helpers (no DOM).
 *
 * The widget's display logic lives in two pure, unit-testable helpers:
 *  - `onTimePercent`: onTime / delivered as a rounded percent (0 when none).
 *  - `formatDeliveryKpi`: the human-readable "X delivered (Y% on time)" string.
 *
 * (The live render + ws-refetch wiring is exercised by the Plan-07 human checkpoint
 *  on the running map — these unit tests cover only the deterministic helpers.)
 *
 * Strict TS: no `any`, no `as`-casting of fixtures.
 */
import { describe, expect, it } from "vitest";
import { formatDeliveryKpi, onTimePercent } from "./DeliveryKpi.js";

describe("DeliveryKpi pure helpers (OUT-05)", () => {
  it("onTimePercent(0, 0) returns 0 (no division by zero, not a fabricated 100%)", () => {
    expect(onTimePercent(0, 0)).toBe(0);
  });

  it("onTimePercent(10, 8) returns 80", () => {
    expect(onTimePercent(10, 8)).toBe(80);
  });

  it("onTimePercent(10, 10) returns 100", () => {
    expect(onTimePercent(10, 10)).toBe(100);
  });

  it("onTimePercent rounds to the nearest whole percent (3 of 7 ≈ 43)", () => {
    expect(onTimePercent(7, 3)).toBe(43);
  });

  it("formatDeliveryKpi(0, 0) reports zero deliveries (0% on time)", () => {
    const s = formatDeliveryKpi(0, 0);
    expect(s).toContain("0 delivered");
    expect(s).toContain("0% on time");
  });

  it("formatDeliveryKpi(10, 8) includes the delivered count and on-time %", () => {
    const s = formatDeliveryKpi(10, 8);
    expect(s).toContain("10");
    expect(s).toContain("80% on time");
  });
});
