import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { PlanningPackage } from "@mm/domain";
import type { Database } from "@mm/event-store";
import { buildApp } from "../src/index.js";

/**
 * Plan 02-06 Task 2 — `POST /plan` integration test (DB-free, `app.inject()`).
 *
 * The endpoint runs the PURE pipeline on the request body
 * (`aggregate → planLoad + baselinePlan → validatePlan → scorePlan →
 * instructions → planExplanation`) and never queries the DB, so we pass a stub
 * `Kysely` handle and exercise it purely via `inject`.
 *
 * Three cases pin the contract:
 *  1. HAPPY PATH — a LIFO-feasible scenario: 200, the recommended plan is
 *     `feasible: true` with zero `hardViolations`, non-empty zone-ordered
 *     `instructions`, a non-empty `explanation`, and both a `plan` and a
 *     `baseline` each carrying a `ScoreResult`.
 *  2. INFEASIBLE GATING (P2 AT THE BOUNDARY) — the LIFO-blind FIFO `baseline`
 *     is the demonstrable infeasible strawman (the route-aware optimizer is
 *     feasible by construction). Its `feasible` is `false` with non-empty
 *     `hardViolations`, WHILE it still carries a `ScoreResult` — proving the
 *     feasibility verdict is derived from `isFeasible(validation)` and reported
 *     INDEPENDENTLY of the score, never bought out by it.
 *  3. BAD INPUT — a malformed body (negative volume) is rejected with 400.
 */

/** A `/plan` request never touches the DB, so a bare stub suffices. */
const STUB_DB = {} as unknown as Kysely<Database>;

/** A 4-hub linear route: hub `H{k+1}` unloads at stop `k` (earlier ⇒ lower order). */
const ROUTE = [
  { hubId: "H1", stopIndex: 0 },
  { hubId: "H2", stopIndex: 1 },
  { hubId: "H3", stopIndex: 2 },
  { hubId: "H4", stopIndex: 3 },
];

/** A valid planning package bound for `nextUnloadHubId`. */
function pkg(
  packageId: string,
  nextUnloadHubId: string,
  volume = 3,
): PlanningPackage {
  return {
    packageId,
    currentHubId: "H0",
    nextUnloadHubId,
    finalDestHubId: "HZ",
    slaClass: "standard",
    handlingClass: "standard",
    sizeWeightClass: "small",
    deadline: 1000,
    deadlineBucket: 0,
    volume,
    weight: 1,
  };
}

/**
 * The scenario is forced to one block per slice by `config.maxBlockVolume == 3`
 * (each block's volume). Distinct next-unload hubs ⇒ the optimizer lays a clean
 * LIFO trailer across multiple depths (multiple zones), while the FIFO baseline
 * (sorted by id, LIFO-blind) buries the earliest-unload freight at the nose ⇒
 * HARD blockers. Six packages → four distinct blocks, one per slice.
 */
const SCENARIO_PACKAGES: PlanningPackage[] = [
  pkg("p1", "H1"),
  pkg("p2", "H2"),
  pkg("p3", "H3"),
  pkg("p4", "H4"),
  pkg("p5", "H1"),
  pkg("p6", "H4"),
];

interface ScoreResultDto {
  readonly rehandleScore: number;
  readonly utilizationScore: number;
}
interface ViolationDto {
  readonly loadBlockId: string;
  readonly blockerCount: number;
  readonly severity: "HARD" | "SOFT";
}
interface ValidationDto {
  readonly hardViolations: readonly ViolationDto[];
  readonly softViolations: readonly ViolationDto[];
}
interface PlanSummaryDto {
  readonly plan: { readonly trailerId: string; readonly slices: readonly unknown[] };
  readonly validation: ValidationDto;
  readonly scores: ScoreResultDto;
  readonly feasible: boolean;
}
interface PlanResponseDto {
  readonly plan: { readonly trailerId: string; readonly slices: readonly unknown[] };
  readonly baseline: PlanSummaryDto;
  readonly instructions: {
    readonly trailerId: string;
    readonly zones: readonly { readonly zone: string; readonly lines: readonly unknown[] }[];
    readonly text: string;
  };
  readonly validation: ValidationDto;
  readonly scores: ScoreResultDto;
  readonly explanation: string;
  readonly feasible: boolean;
}

describe("POST /plan — pure load-planning pipeline at the API boundary (LOAD-08)", () => {
  it("HAPPY PATH: 200, recommended plan feasible with zone-ordered instructions + explanation", async () => {
    const app = buildApp(STUB_DB);
    const res = await app.inject({
      method: "POST",
      url: "/plan",
      payload: {
        packages: SCENARIO_PACKAGES,
        route: ROUTE,
        config: { maxBlockVolume: 3 },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<PlanResponseDto>();

    // Recommended (route-aware) plan: feasible, no hard violations.
    expect(body.feasible).toBe(true);
    expect(body.validation.hardViolations).toHaveLength(0);

    // Scores reported alongside (separate object — P2).
    expect(typeof body.scores.rehandleScore).toBe("number");
    expect(typeof body.scores.utilizationScore).toBe("number");

    // Zone-ordered loading instructions present and physical-order labelled.
    expect(body.instructions.zones.length).toBeGreaterThan(0);
    expect(body.instructions.text.length).toBeGreaterThan(0);
    // Multi-depth trailer ⇒ at least one zone with loadable lines.
    expect(
      body.instructions.zones.some((z) => z.lines.length > 0),
    ).toBe(true);

    // Human-readable explanation.
    expect(body.explanation.length).toBeGreaterThan(0);

    // Both a plan and a baseline, each with a ScoreResult.
    expect(body.plan.trailerId.length).toBeGreaterThan(0);
    expect(body.baseline.plan.trailerId.length).toBeGreaterThan(0);
    expect(typeof body.scores.rehandleScore).toBe("number");
    expect(typeof body.baseline.scores.rehandleScore).toBe("number");
    expect(typeof body.baseline.scores.utilizationScore).toBe("number");

    await app.close();
  });

  it("INFEASIBLE GATING (P2): the FIFO baseline is infeasible with HARD violations, yet still carries a score", async () => {
    const app = buildApp(STUB_DB);
    const res = await app.inject({
      method: "POST",
      url: "/plan",
      payload: {
        packages: SCENARIO_PACKAGES,
        route: ROUTE,
        config: { maxBlockVolume: 3 },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<PlanResponseDto>();

    // The strawman baseline is the demonstrable infeasible plan: its feasibility
    // is gated on the validator's HARD violations, NOT on the score.
    expect(body.baseline.feasible).toBe(false);
    expect(body.baseline.validation.hardViolations.length).toBeGreaterThan(0);
    expect(
      body.baseline.validation.hardViolations.every((v) => v.severity === "HARD"),
    ).toBe(true);

    // CRITICAL P2: the score is STILL reported next to the infeasible verdict —
    // proving feasibility is derived from `isFeasible(validation)` independently
    // of the score, never bought out by it.
    expect(typeof body.baseline.scores.rehandleScore).toBe("number");
    expect(typeof body.baseline.scores.utilizationScore).toBe("number");

    // The two are distinct objects on the wire: validation carries no score
    // fields; scores carries no violation fields.
    expect(body.baseline.scores).not.toHaveProperty("hardViolations");
    expect(body.baseline.validation).not.toHaveProperty("rehandleScore");

    await app.close();
  });

  it("BAD INPUT: a malformed body (negative volume) is rejected with 400", async () => {
    const app = buildApp(STUB_DB);
    const res = await app.inject({
      method: "POST",
      url: "/plan",
      payload: {
        packages: [{ ...pkg("bad", "H1"), volume: -5 }],
        route: ROUTE,
      },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it("BAD INPUT: a missing `route` is rejected with 400", async () => {
    const app = buildApp(STUB_DB);
    const res = await app.inject({
      method: "POST",
      url: "/plan",
      payload: { packages: SCENARIO_PACKAGES },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it("keeps GET /hubs + GET /health registered (no prior-route regression)", async () => {
    const app = buildApp(STUB_DB);

    // /health is a pure handler — still 200.
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    // /hubs is REGISTERED: with the stub DB the query throws (500), but the
    // route resolves — it is NOT a 404 missing-route. This guards the prior
    // walking-skeleton endpoint against accidental removal.
    const hubs = await app.inject({ method: "GET", url: "/hubs" });
    expect(hubs.statusCode).not.toBe(404);

    await app.close();
  });
});
