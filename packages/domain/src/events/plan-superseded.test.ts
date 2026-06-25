import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type DomainEvent,
  type PlanSuperseded,
  planSupersededSchema,
  validateEvent,
  ValidationError,
} from "../index.js";

/**
 * Plan 21-01 (RED first / FLOW-04 / D-21-1): `PlanSuperseded` — the SOLE
 * stage-mutating plan event. The optimizer emits it in the SAME atomic append
 * as the new `PlanAccepted`; the hub-inventory reducer stays a dumb pure
 * delete-then-apply over `supersededPackageIds`.
 *
 * Payload carries HOLISTIC scope state (D-21-1): `supersededPackageIds` is every
 * packageId the prior plan staged for this scope, so the reducer can wipe stale
 * staged WITHOUT stranding items present in the old plan but absent in the new.
 *
 * Like every member, it is a first-class member of the CLOSED, VERSIONED
 * `DomainEvent` union, zod-validated through the `validateEvent` ingestion
 * boundary, with the build gate (`contract.assert.ts`) enforcing schema/union
 * parity and exhaustiveness.
 *
 * Determinism: `occurredAt` is the VIRTUAL clock ISO string (never `Date.now()`).
 */

const planSuperseded: PlanSuperseded = {
  type: "PlanSuperseded",
  schemaVersion: 1,
  payload: {
    epochId: "epoch-8",
    scopeHash: "sha256:def456",
    priorPlanId: "plan-42",
    trailerId: "T1",
    supersededPackageIds: ["P00001", "P00002"],
    reason: "superseded by plan-43",
    occurredAt: "2026-06-24T12:00:02.000Z",
  },
};

describe("PlanSuperseded — closed-union membership (FLOW-04 / D-21-1)", () => {
  it("is assignable to the DomainEvent union", () => {
    const events: readonly DomainEvent[] = [planSuperseded];
    expect(events.map((e) => e.type)).toEqual(["PlanSuperseded"]);
    expectTypeOf(planSuperseded).toMatchTypeOf<DomainEvent>();
  });

  it("pins its discriminator + version + holistic-scope payload field types", () => {
    expectTypeOf(planSuperseded.type).toEqualTypeOf<"PlanSuperseded">();
    expectTypeOf(planSuperseded.schemaVersion).toEqualTypeOf<1>();
    expectTypeOf(planSuperseded.payload.epochId).toEqualTypeOf<string>();
    expectTypeOf(planSuperseded.payload.scopeHash).toEqualTypeOf<string>();
    expectTypeOf(planSuperseded.payload.priorPlanId).toEqualTypeOf<string>();
    expectTypeOf(planSuperseded.payload.trailerId).toEqualTypeOf<string>();
    expectTypeOf(
      planSuperseded.payload.supersededPackageIds,
    ).toEqualTypeOf<string[]>();
    expectTypeOf(planSuperseded.payload.reason).toEqualTypeOf<string>();
    expectTypeOf(planSuperseded.payload.occurredAt).toEqualTypeOf<string>();
  });
});

describe("validateEvent — accepts a well-formed PlanSuperseded (FLOW-04)", () => {
  it("round-trips a well-formed PlanSuperseded as a typed event", () => {
    const parsed = validateEvent(planSuperseded);
    expect(parsed).toEqual(planSuperseded);
    expect(parsed.type).toBe("PlanSuperseded");
  });

  it("planSupersededSchema parses standalone", () => {
    expect(planSupersededSchema.safeParse(planSuperseded).success).toBe(true);
  });

  it("accepts an EMPTY supersededPackageIds array (first plan / nothing to wipe)", () => {
    const empty: PlanSuperseded = {
      ...planSuperseded,
      payload: { ...planSuperseded.payload, supersededPackageIds: [] },
    };
    expect(validateEvent(empty)).toEqual(empty);
  });
});

describe("validateEvent — rejects malformed PlanSuperseded (T-21-01 Tampering)", () => {
  it("rejects a PlanSuperseded with an extra (unrecognized) field — strict payload", () => {
    expect(() =>
      validateEvent({
        type: "PlanSuperseded",
        schemaVersion: 1,
        payload: { ...planSuperseded.payload, objectiveCost: 1 },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a PlanSuperseded whose supersededPackageIds is not an array", () => {
    expect(() =>
      validateEvent({
        type: "PlanSuperseded",
        schemaVersion: 1,
        payload: { ...planSuperseded.payload, supersededPackageIds: "P00001" },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a PlanSuperseded with an empty reason (non-empty constraint)", () => {
    expect(() =>
      validateEvent({
        type: "PlanSuperseded",
        schemaVersion: 1,
        payload: { ...planSuperseded.payload, reason: "" },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a PlanSuperseded with an empty priorPlanId (non-empty id constraint)", () => {
    expect(() =>
      validateEvent({
        type: "PlanSuperseded",
        schemaVersion: 1,
        payload: { ...planSuperseded.payload, priorPlanId: "" },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects an unsupported schemaVersion for PlanSuperseded", () => {
    expect(() =>
      validateEvent({
        type: "PlanSuperseded",
        schemaVersion: 2,
        payload: planSuperseded.payload,
      }),
    ).toThrow(ValidationError);
  });
});
