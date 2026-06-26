import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type DomainEvent,
  type TrailerDiverted,
  trailerDivertedSchema,
  validateEvent,
  ValidationError,
} from "../index.js";

/**
 * Phase-24 OODA-01 (RED first): the NEW `TrailerDiverted` re-route event — the
 * ONE genuinely-new truck decision with no current centralized analog. It must
 * be a first-class member of the CLOSED, VERSIONED `DomainEvent` union,
 * zod-validated through the `validateEvent` boundary, with the build gate
 * (`contract.assert.ts`) enforcing schema/union parity + exhaustiveness across
 * every reducer.
 *
 * Anti-repudiation (T-24-02): the payload carries `reason` + `tripId` + from/to
 * hub ids so every divert is replayable/auditable. Determinism: ids + a domain
 * clock string only — NO lon/lat, NO RNG value.
 */

const diverted: TrailerDiverted = {
  type: "TrailerDiverted",
  schemaVersion: 1,
  payload: {
    trailerId: "T001",
    tripId: "TRIP00001",
    fromHubId: "ORD",
    toHubId: "DFW",
    reason: "next-hub-congested",
    occurredAt: "2026-04-01T05:00:00.000Z",
  },
};

describe("TrailerDiverted — closed-union membership (OODA-01)", () => {
  it("is assignable to the DomainEvent union", () => {
    const events: readonly DomainEvent[] = [diverted];
    expect(events.map((e) => e.type)).toEqual(["TrailerDiverted"]);
    expectTypeOf(diverted).toMatchTypeOf<DomainEvent>();
  });

  it("pins its discriminator + version + payload field types (ids + reason, NO geo)", () => {
    expectTypeOf(diverted.type).toEqualTypeOf<"TrailerDiverted">();
    expectTypeOf(diverted.schemaVersion).toEqualTypeOf<1>();
    expectTypeOf(diverted.payload.trailerId).toEqualTypeOf<string>();
    expectTypeOf(diverted.payload.tripId).toEqualTypeOf<string>();
    expectTypeOf(diverted.payload.fromHubId).toEqualTypeOf<string>();
    expectTypeOf(diverted.payload.toHubId).toEqualTypeOf<string>();
    expectTypeOf(diverted.payload.occurredAt).toEqualTypeOf<string>();
    // No lon/lat in the payload (geometry-free — the geo-track projection owns position).
    expectTypeOf(diverted.payload).not.toHaveProperty("lon");
    expectTypeOf(diverted.payload).not.toHaveProperty("lat");
  });
});

describe("validateEvent — accepts a well-formed TrailerDiverted", () => {
  it("round-trips a well-formed TrailerDiverted as a typed event", () => {
    const parsed = validateEvent(diverted);
    expect(parsed).toEqual(diverted);
    expect(parsed.type).toBe("TrailerDiverted");
  });

  it("the standalone schema parses every valid reason enum value", () => {
    for (const reason of ["next-hub-congested", "next-hub-blocked", "rebalance"] as const) {
      expect(
        trailerDivertedSchema.safeParse({
          ...diverted,
          payload: { ...diverted.payload, reason },
        }).success,
      ).toBe(true);
    }
  });
});

describe("validateEvent — rejects a malformed TrailerDiverted (T tampering)", () => {
  it("rejects an unknown reason enum value", () => {
    expect(() =>
      validateEvent({
        type: "TrailerDiverted",
        schemaVersion: 1,
        payload: { ...diverted.payload, reason: "vacation" },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a missing required id field (toHubId)", () => {
    const { toHubId: _omit, ...rest } = diverted.payload;
    void _omit;
    expect(() =>
      validateEvent({ type: "TrailerDiverted", schemaVersion: 1, payload: rest }),
    ).toThrow(ValidationError);
  });

  it("rejects an empty-string id (anti-empty-id)", () => {
    expect(() =>
      validateEvent({
        type: "TrailerDiverted",
        schemaVersion: 1,
        payload: { ...diverted.payload, trailerId: "" },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects an extra/unexpected payload field (strict boundary)", () => {
    expect(() =>
      validateEvent({
        type: "TrailerDiverted",
        schemaVersion: 1,
        payload: { ...diverted.payload, lat: 41.8 },
      }),
    ).toThrow(ValidationError);
  });
});
