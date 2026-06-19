import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type DomainEvent,
  type PlanAccepted,
  type PlanGenerated,
  planAcceptedSchema,
  planGeneratedSchema,
  validateEvent,
  ValidationError,
} from "../index.js";

/**
 * Plan 04-01 (RED first): the two plan-lifecycle events that anchor OPT-04.
 *
 *  - `PlanGenerated`: a candidate plan was produced over the twin (NO side
 *    effect — purely observational; carries the weighted objective + a hard
 *    feasibility flag).
 *  - `PlanAccepted`: the ONE operational side effect when a candidate is
 *    committed.
 *
 * Both are first-class members of the CLOSED, VERSIONED `DomainEvent` union,
 * zod-validated through the `validateEvent` ingestion boundary, with the build
 * gate (`contract.assert.ts`) enforcing schema/union parity and exhaustiveness.
 *
 * Determinism (OPT determinism rule): `occurredAt` is a caller-supplied domain
 * clock string — the domain never calls `Date.now()`.
 */

const planGenerated: PlanGenerated = {
  type: "PlanGenerated",
  schemaVersion: 1,
  payload: {
    epochId: "epoch-7",
    scopeHash: "sha256:abc123",
    planId: "plan-42",
    trailerId: "T1",
    objectiveCost: 1234.5,
    feasible: true,
    occurredAt: "2026-06-19T12:00:00.000Z",
  },
};

const planAccepted: PlanAccepted = {
  type: "PlanAccepted",
  schemaVersion: 1,
  payload: {
    epochId: "epoch-7",
    scopeHash: "sha256:abc123",
    planId: "plan-42",
    trailerId: "T1",
    occurredAt: "2026-06-19T12:00:01.000Z",
  },
};

describe("PlanGenerated / PlanAccepted — closed-union membership (OPT-04)", () => {
  it("both are assignable to the DomainEvent union", () => {
    const events: readonly DomainEvent[] = [planGenerated, planAccepted];
    expect(events.map((e) => e.type)).toEqual(["PlanGenerated", "PlanAccepted"]);
    // Type-level proof: each new member is assignable to DomainEvent.
    expectTypeOf(planGenerated).toMatchTypeOf<DomainEvent>();
    expectTypeOf(planAccepted).toMatchTypeOf<DomainEvent>();
  });

  it("PlanGenerated pins its discriminator + version + payload field types", () => {
    expectTypeOf(planGenerated.type).toEqualTypeOf<"PlanGenerated">();
    expectTypeOf(planGenerated.schemaVersion).toEqualTypeOf<1>();
    expectTypeOf(planGenerated.payload.objectiveCost).toEqualTypeOf<number>();
    expectTypeOf(planGenerated.payload.feasible).toEqualTypeOf<boolean>();
    expectTypeOf(planGenerated.payload.epochId).toEqualTypeOf<string>();
    expectTypeOf(planGenerated.payload.scopeHash).toEqualTypeOf<string>();
    expectTypeOf(planGenerated.payload.occurredAt).toEqualTypeOf<string>();
  });

  it("PlanAccepted carries the idempotency keys but no objective/feasibility", () => {
    expectTypeOf(planAccepted.type).toEqualTypeOf<"PlanAccepted">();
    expectTypeOf(planAccepted.payload.planId).toEqualTypeOf<string>();
    expectTypeOf(planAccepted.payload.epochId).toEqualTypeOf<string>();
    expectTypeOf(planAccepted.payload.scopeHash).toEqualTypeOf<string>();
    // PlanAccepted intentionally has NO objectiveCost/feasible (accept is the
    // commit, not the evaluation).
    expectTypeOf(planAccepted.payload).not.toHaveProperty("objectiveCost");
    expectTypeOf(planAccepted.payload).not.toHaveProperty("feasible");
  });
});

describe("validateEvent — accepts well-formed plan events (OPT-04)", () => {
  it("round-trips a well-formed PlanGenerated as a typed event", () => {
    const parsed = validateEvent(planGenerated);
    expect(parsed).toEqual(planGenerated);
    expect(parsed.type).toBe("PlanGenerated");
  });

  it("round-trips a well-formed PlanAccepted as a typed event", () => {
    const parsed = validateEvent(planAccepted);
    expect(parsed).toEqual(planAccepted);
    expect(parsed.type).toBe("PlanAccepted");
  });

  it("planGeneratedSchema / planAcceptedSchema parse standalone", () => {
    expect(planGeneratedSchema.safeParse(planGenerated).success).toBe(true);
    expect(planAcceptedSchema.safeParse(planAccepted).success).toBe(true);
  });
});

describe("validateEvent — rejects malformed plan events (T-04-01 Tampering)", () => {
  it("rejects a PlanGenerated missing objectiveCost, naming the field", () => {
    const withoutObjectiveCost = {
      epochId: planGenerated.payload.epochId,
      scopeHash: planGenerated.payload.scopeHash,
      planId: planGenerated.payload.planId,
      trailerId: planGenerated.payload.trailerId,
      feasible: planGenerated.payload.feasible,
      occurredAt: planGenerated.payload.occurredAt,
    };
    let caught: unknown;
    try {
      validateEvent({
        type: "PlanGenerated",
        schemaVersion: 1,
        payload: withoutObjectiveCost,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toMatch(/objectiveCost/);
  });

  it("rejects a PlanGenerated whose objectiveCost is not a number", () => {
    expect(() =>
      validateEvent({
        type: "PlanGenerated",
        schemaVersion: 1,
        payload: { ...planGenerated.payload, objectiveCost: "free" },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a PlanGenerated whose feasible is not a boolean", () => {
    expect(() =>
      validateEvent({
        type: "PlanGenerated",
        schemaVersion: 1,
        payload: { ...planGenerated.payload, feasible: "yes" },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a PlanGenerated with an empty planId (non-empty id constraint)", () => {
    expect(() =>
      validateEvent({
        type: "PlanGenerated",
        schemaVersion: 1,
        payload: { ...planGenerated.payload, planId: "" },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a PlanAccepted with an extra (unrecognized) field — strict payload", () => {
    expect(() =>
      validateEvent({
        type: "PlanAccepted",
        schemaVersion: 1,
        payload: { ...planAccepted.payload, objectiveCost: 1 },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects an unsupported schemaVersion for a plan event", () => {
    expect(() =>
      validateEvent({
        type: "PlanAccepted",
        schemaVersion: 2,
        payload: planAccepted.payload,
      }),
    ).toThrow(ValidationError);
  });
});
