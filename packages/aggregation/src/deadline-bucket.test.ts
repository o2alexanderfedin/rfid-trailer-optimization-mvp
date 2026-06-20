import { describe, expect, it } from "vitest";
import type { SlaClass } from "@mm/domain";
import { deadlineBucket } from "./deadline-bucket.js";

/**
 * AGG / deadlineBucket (Task 1): a PURE, deterministic coarse time bucket
 * derived from the deadline (ms since a fixed epoch, from payload timestamps)
 * and the SLA-class window. NO wall clock. Same inputs => same bucket.
 */
describe("deadlineBucket", () => {
  it("is deterministic: same (deadline, slaClass) => same bucket", () => {
    expect(deadlineBucket(123_456_789, "standard")).toBe(
      deadlineBucket(123_456_789, "standard"),
    );
  });

  it("returns a non-negative integer", () => {
    const b = deadlineBucket(987_654_321, "express");
    expect(Number.isInteger(b)).toBe(true);
    expect(b).toBeGreaterThanOrEqual(0);
  });

  it("maps deadline 0 to bucket 0 for every SLA class", () => {
    const classes: SlaClass[] = ["express", "priority", "standard", "economy"];
    for (const c of classes) {
      expect(deadlineBucket(0, c)).toBe(0);
    }
  });

  it("two deadlines inside the same window share a bucket", () => {
    // Two close deadlines (1 ms apart) must never straddle a bucket edge for a
    // coarse bucket; pick a value far from an edge.
    const a = deadlineBucket(1_000_000_000, "standard");
    const b = deadlineBucket(1_000_000_001, "standard");
    expect(a).toBe(b);
  });

  it("a much later deadline yields a strictly larger bucket", () => {
    const early = deadlineBucket(1_000_000, "standard");
    const late = deadlineBucket(1_000_000 + 10 * 24 * 3_600_000, "standard");
    expect(late).toBeGreaterThan(early);
  });

  it("is monotonic non-decreasing in the deadline", () => {
    let prev = deadlineBucket(0, "priority");
    for (let ms = 0; ms <= 30 * 24 * 3_600_000; ms += 6 * 3_600_000) {
      const cur = deadlineBucket(ms, "priority");
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it("uses a finer window for tighter SLA classes (express discriminates more than economy)", () => {
    // For the SAME absolute deadline spread, a tighter SLA (express) should
    // distinguish two deadlines into different buckets where a looser SLA
    // (economy) lumps them together — express window < economy window.
    const lo = 10 * 3_600_000; // 10h
    const hi = 20 * 3_600_000; // 20h
    const expressSpan = deadlineBucket(hi, "express") - deadlineBucket(lo, "express");
    const economySpan = deadlineBucket(hi, "economy") - deadlineBucket(lo, "economy");
    expect(expressSpan).toBeGreaterThan(economySpan);
  });
});
