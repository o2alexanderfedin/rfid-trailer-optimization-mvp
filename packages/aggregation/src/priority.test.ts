import { describe, expect, it } from "vitest";
import { type SlaClass, SLA_CLASS_WEIGHT } from "@mm/domain";
import { blockPriority, type PrioritizableBlock } from "./priority.js";

/**
 * AGG-04 / blockPriority (Task 1): a single comparable number encoding the
 * lexicographic order (SLA-class weight DESCENDING, then earliest deadline
 * ASCENDING). Higher SLA weight ALWAYS outranks any deadline; within equal SLA,
 * an earlier deadline outranks a later one.
 *
 * `LoadBlock` (domain) carries no deadline, so priority is computed from the
 * minimal structural input {@link PrioritizableBlock}: the block's SLA class
 * plus its representative (earliest) deadline. The aggregator supplies both.
 */

function block(slaClass: SlaClass, deadline: number): PrioritizableBlock {
  return { slaClass, deadline };
}

describe("blockPriority", () => {
  it("is deterministic for identical inputs", () => {
    expect(blockPriority(block("standard", 1000))).toBe(
      blockPriority(block("standard", 1000)),
    );
  });

  it("ranks earlier deadline higher within the same SLA class", () => {
    expect(blockPriority(block("standard", 1000))).toBeGreaterThan(
      blockPriority(block("standard", 5000)),
    );
  });

  it("SLA weight DOMINATES deadline (express with a far deadline still outranks economy with a near deadline)", () => {
    expect(blockPriority(block("express", 10_000_000_000))).toBeGreaterThan(
      blockPriority(block("economy", 0)),
    );
  });

  it("property: higher SLA weight => higher priority regardless of deadlines", () => {
    const classes: SlaClass[] = ["express", "priority", "standard", "economy"];
    const deadlines = [0, 1, 1_000, 1_000_000, 9_999_999_999];
    for (const ca of classes) {
      for (const cb of classes) {
        if (SLA_CLASS_WEIGHT[ca] <= SLA_CLASS_WEIGHT[cb]) continue;
        for (const da of deadlines) {
          for (const db of deadlines) {
            expect(blockPriority(block(ca, da))).toBeGreaterThan(
              blockPriority(block(cb, db)),
            );
          }
        }
      }
    }
  });

  it("equal SLA + equal deadline => equal priority", () => {
    expect(blockPriority(block("priority", 42))).toBe(
      blockPriority(block("priority", 42)),
    );
  });
});
