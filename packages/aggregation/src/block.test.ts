import { describe, expect, it } from "vitest";
import type { BlockKey } from "@mm/domain";
import { keyId } from "./block.js";

/**
 * `keyId` must be a COLLISION-SAFE canonical encoding of a {@link BlockKey}: two
 * DISTINCT keys must NEVER produce the same id. The hub-id fields are arbitrary
 * `z.string().min(1)` values, so they can contain ANY character — including a
 * naive field separator. A length-prefix / JSON encoding makes the boundary
 * unambiguous so distinct keys can never alias (L4).
 */

const BASE: BlockKey = {
  currentHubId: "H1",
  nextUnloadHubId: "H2",
  finalDestHubId: "H3",
  slaClass: "standard",
  deadlineBucket: 0,
  handlingClass: "standard",
  sizeWeightClass: "small",
};

describe("keyId — collision-safe encoding (L4)", () => {
  it("distinguishes keys whose fields contain the separator glyph (no aliasing)", () => {
    // If keyId joined on the unit-separator glyph `␟` (U+241F), these two
    // distinct keys would collide: "A␟B" + "C" vs "A" + "B␟C" both flatten to
    // "A␟B␟C" across the first two fields.
    const a: BlockKey = { ...BASE, currentHubId: "A␟B", nextUnloadHubId: "C" };
    const b: BlockKey = { ...BASE, currentHubId: "A", nextUnloadHubId: "B␟C" };

    expect(keyId(a)).not.toBe(keyId(b));
  });

  it("distinguishes keys that differ only by where a field boundary falls", () => {
    const a: BlockKey = { ...BASE, finalDestHubId: "X|Y", slaClass: "express" };
    const b: BlockKey = { ...BASE, finalDestHubId: "X", slaClass: "express" };
    expect(keyId(a)).not.toBe(keyId(b));
  });

  it("is deterministic and stable for the same key (replay-safe)", () => {
    expect(keyId(BASE)).toBe(keyId({ ...BASE }));
  });

  it("two genuinely-equal keys built independently share an id", () => {
    const a: BlockKey = { ...BASE, currentHubId: "HUB-42" };
    const b: BlockKey = { ...BASE, currentHubId: "HUB-42" };
    expect(keyId(a)).toBe(keyId(b));
  });
});
