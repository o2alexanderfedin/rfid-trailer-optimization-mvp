import type { ActionSuggested } from "@mm/domain";
import { describe, expect, it } from "vitest";

import { canonicalizeSuggestionPayload } from "./canonical.js";

/**
 * Phase-25 COORD-02 / DET-03 / Pitfall 7 — the `ActionSuggested` hashed payload
 * MUST route through a single fixed-key-order canonicalizer so two logically-
 * identical suggestions serialize to byte-identical JSON regardless of how the
 * object literal happened to be built (or refactored later). This mirrors the
 * OODA `canonicalizeOodaPayload` discipline (a single fixed-key-order site,
 * values untouched, key order pinned).
 */

const REFERENCE: ActionSuggested["payload"] = {
  suggestionId: "SUG-00001",
  coordinatorId: "COORD-MEM",
  targetAgentId: "T001",
  kind: "reroute",
  params: { toHubId: "DFW" },
  issuedAtSimMs: 3_600_000,
  ttlSimMs: 360_000,
};

describe("canonicalizeSuggestionPayload — fixed-key-order pin (Pitfall 7)", () => {
  it("returns the same field VALUES (a pure value-preserving mapping)", () => {
    const out = canonicalizeSuggestionPayload(REFERENCE);
    expect(out).toEqual(REFERENCE);
  });

  it("emits the canonical fixed key order regardless of input insertion order", () => {
    // Build a logically-identical payload with a SCRAMBLED insertion order — the
    // canonicalizer must normalize both to the SAME byte sequence (the golden hash
    // is JSON.stringify, which is key-order sensitive).
    const scrambled: ActionSuggested["payload"] = {
      ttlSimMs: 360_000,
      params: { toHubId: "DFW" },
      kind: "reroute",
      targetAgentId: "T001",
      issuedAtSimMs: 3_600_000,
      coordinatorId: "COORD-MEM",
      suggestionId: "SUG-00001",
    };
    const a = JSON.stringify(canonicalizeSuggestionPayload(REFERENCE));
    const b = JSON.stringify(canonicalizeSuggestionPayload(scrambled));
    expect(b).toBe(a);
    // And the pinned order is exactly the zod schema declaration order.
    expect(Object.keys(canonicalizeSuggestionPayload(scrambled))).toEqual([
      "suggestionId",
      "coordinatorId",
      "targetAgentId",
      "kind",
      "params",
      "issuedAtSimMs",
      "ttlSimMs",
    ]);
  });

  it("is idempotent — canonicalizing an already-canonical payload is byte-identical", () => {
    const once = canonicalizeSuggestionPayload(REFERENCE);
    const twice = canonicalizeSuggestionPayload(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("preserves an empty params object (hold/consolidate carry no destination)", () => {
    const hold: ActionSuggested["payload"] = {
      ...REFERENCE,
      kind: "hold",
      params: {},
    };
    const out = canonicalizeSuggestionPayload(hold);
    expect(out.params).toEqual({});
    expect(out.kind).toBe("hold");
  });
});
