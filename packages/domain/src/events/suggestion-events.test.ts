import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type ActionSuggested,
  actionSuggestedSchema,
  type DomainEvent,
  type SuggestionAccepted,
  suggestionAcceptedSchema,
  type SuggestionRejected,
  suggestionRejectedSchema,
  validateEvent,
  ValidationError,
} from "../index.js";

/**
 * Phase-25 COORD-02 (RED first): the THREE advisory coordination events —
 * `ActionSuggested` / `SuggestionAccepted` / `SuggestionRejected` — the event
 * SUBSTRATE for the whole phase. They must be first-class members of the CLOSED,
 * VERSIONED `DomainEvent` union, zod-validated through the `validateEvent`
 * boundary, with the build gate (`contract.assert.ts`) enforcing schema/union
 * parity + exhaustiveness across every reducer.
 *
 * DETERMINISM (Pitfall 1/7): the `ActionSuggested` payload is ids + a CLOSED
 * `kind` enum + an integer/string-only `params` object + sim-time integers ONLY
 * — NO float geometry, NO RNG value. `SuggestionRejected.reasonCode` is a CLOSED
 * enum (`hos | fuel | dock | infeasible`). All three are scope-neutral in
 * scope.ts (asserted separately in the optimizer suite).
 */

const actionSuggested: ActionSuggested = {
  type: "ActionSuggested",
  schemaVersion: 1,
  payload: {
    suggestionId: "SUG-00001",
    coordinatorId: "COORD-MEM",
    targetAgentId: "T001",
    kind: "reroute",
    params: { toHubId: "DFW" },
    issuedAtSimMs: 3_600_000,
    ttlSimMs: 360_000,
  },
};

const suggestionAccepted: SuggestionAccepted = {
  type: "SuggestionAccepted",
  schemaVersion: 1,
  payload: {
    suggestionId: "SUG-00001",
    occurredAt: "2026-04-01T05:00:00.000Z",
  },
};

const suggestionRejected: SuggestionRejected = {
  type: "SuggestionRejected",
  schemaVersion: 1,
  payload: {
    suggestionId: "SUG-00001",
    reasonCode: "hos",
    occurredAt: "2026-04-01T05:00:00.000Z",
  },
};

describe("the three suggestion events — closed-union membership (COORD-02)", () => {
  it("are all assignable to the DomainEvent union", () => {
    const events: readonly DomainEvent[] = [
      actionSuggested,
      suggestionAccepted,
      suggestionRejected,
    ];
    expect(events.map((e) => e.type)).toEqual([
      "ActionSuggested",
      "SuggestionAccepted",
      "SuggestionRejected",
    ]);
    expectTypeOf(actionSuggested).toMatchTypeOf<DomainEvent>();
    expectTypeOf(suggestionAccepted).toMatchTypeOf<DomainEvent>();
    expectTypeOf(suggestionRejected).toMatchTypeOf<DomainEvent>();
  });

  it("pin the ActionSuggested payload field types (ids + closed enum + sim-time ints, NO geo float)", () => {
    expectTypeOf(actionSuggested.type).toEqualTypeOf<"ActionSuggested">();
    expectTypeOf(actionSuggested.schemaVersion).toEqualTypeOf<1>();
    expectTypeOf(actionSuggested.payload.suggestionId).toEqualTypeOf<string>();
    expectTypeOf(actionSuggested.payload.coordinatorId).toEqualTypeOf<string>();
    expectTypeOf(actionSuggested.payload.targetAgentId).toEqualTypeOf<string>();
    expectTypeOf(actionSuggested.payload.kind).toEqualTypeOf<
      "reroute" | "hold" | "consolidate" | "dispatch"
    >();
    expectTypeOf(actionSuggested.payload.issuedAtSimMs).toEqualTypeOf<number>();
    expectTypeOf(actionSuggested.payload.ttlSimMs).toEqualTypeOf<number>();
    // No lon/lat in the payload (geometry-free — Pitfall 1).
    expectTypeOf(actionSuggested.payload).not.toHaveProperty("lon");
    expectTypeOf(actionSuggested.payload).not.toHaveProperty("lat");
  });

  it("pin the SuggestionRejected closed reasonCode enum", () => {
    expectTypeOf(suggestionRejected.payload.reasonCode).toEqualTypeOf<
      "hos" | "fuel" | "dock" | "infeasible"
    >();
  });
});

describe("validateEvent — accepts well-formed suggestion events", () => {
  it("round-trips a well-formed ActionSuggested", () => {
    const parsed = validateEvent(actionSuggested);
    expect(parsed).toEqual(actionSuggested);
    expect(parsed.type).toBe("ActionSuggested");
  });

  it("round-trips a well-formed SuggestionAccepted + SuggestionRejected", () => {
    expect(validateEvent(suggestionAccepted)).toEqual(suggestionAccepted);
    expect(validateEvent(suggestionRejected)).toEqual(suggestionRejected);
  });

  it("the standalone ActionSuggested schema parses every valid kind enum value", () => {
    for (const kind of ["reroute", "hold", "consolidate", "dispatch"] as const) {
      expect(
        actionSuggestedSchema.safeParse({
          ...actionSuggested,
          payload: { ...actionSuggested.payload, kind },
        }).success,
      ).toBe(true);
    }
  });

  it("the standalone SuggestionRejected schema parses every valid reasonCode value", () => {
    for (const reasonCode of ["hos", "fuel", "dock", "infeasible"] as const) {
      expect(
        suggestionRejectedSchema.safeParse({
          ...suggestionRejected,
          payload: { ...suggestionRejected.payload, reasonCode },
        }).success,
      ).toBe(true);
    }
  });

  it("the standalone SuggestionAccepted schema accepts the minimal id + clock payload", () => {
    expect(suggestionAcceptedSchema.safeParse(suggestionAccepted).success).toBe(
      true,
    );
  });
});

describe("validateEvent — rejects malformed suggestion events (T tampering)", () => {
  it("rejects an ActionSuggested missing ttlSimMs", () => {
    const { ttlSimMs: _omit, ...rest } = actionSuggested.payload;
    void _omit;
    expect(() =>
      validateEvent({
        type: "ActionSuggested",
        schemaVersion: 1,
        payload: rest,
      }),
    ).toThrow(ValidationError);
  });

  it("rejects an ActionSuggested kind outside the closed enum", () => {
    expect(() =>
      validateEvent({
        type: "ActionSuggested",
        schemaVersion: 1,
        payload: { ...actionSuggested.payload, kind: "teleport" },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a SuggestionRejected reasonCode outside the closed enum", () => {
    expect(() =>
      validateEvent({
        type: "SuggestionRejected",
        schemaVersion: 1,
        payload: { ...suggestionRejected.payload, reasonCode: "whatever" },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects an empty-string suggestionId (anti-empty-id)", () => {
    expect(() =>
      validateEvent({
        type: "SuggestionAccepted",
        schemaVersion: 1,
        payload: { ...suggestionAccepted.payload, suggestionId: "" },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects an extra/unexpected ActionSuggested payload field (strict boundary)", () => {
    expect(() =>
      validateEvent({
        type: "ActionSuggested",
        schemaVersion: 1,
        payload: { ...actionSuggested.payload, lat: 41.8 },
      }),
    ).toThrow(ValidationError);
  });
});
