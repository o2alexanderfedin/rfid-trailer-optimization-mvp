import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  DEFAULT_PLANNER_CONFIG,
  planningPackageSchema,
  plannerConfigObjectSchema,
  plannerConfigSchema,
  routeStopSchema,
  type PlannerConfig,
  type PlanningPackage,
  type RouteStop,
} from "@mm/domain";
import { aggregate } from "@mm/aggregation";
import {
  baselinePlan,
  instructions,
  isFeasible,
  planExplanation,
  planLoad,
  scorePlan,
  validatePlan,
  type FeasibilityResult,
  type LoadingInstructions,
  type LoadPlan,
  type ScoreResult,
} from "@mm/load-planner";

/**
 * `POST /plan` (LOAD-08) — the thin composition root that turns the PURE
 * planner modules into a thing an operator can call and eyeball.
 *
 * Design (KISS / YAGNI / DIP — smallest correct surface):
 *  - The route is a THIN handler: validate the untrusted body with the domain's
 *    own zod schemas (T-02-17), then run ONE pure pipeline and map to a stable
 *    DTO. It is READ-ONLY — no event-store writes, no `PlanGenerated` (deferred
 *    to Phase 4) — so it needs no DB and is `app.inject()`-testable DB-free.
 *  - The pipeline is exactly the phase's pure flow on the SAME inputs:
 *
 *        aggregate → planLoad + baselinePlan → validatePlan → scorePlan
 *                  → instructions → planExplanation
 *
 *  - CRITICAL — P2 AT THE BOUNDARY (T-02-18): `feasible` is derived from
 *    `isFeasible(validation)` (zero HARD violations), computed INDEPENDENTLY of
 *    and reported ALONGSIDE the score. The score is exposed but can never
 *    override the feasibility verdict — `FeasibilityResult` and `ScoreResult`
 *    are distinct objects all the way to the wire. Both the recommended
 *    (route-aware) plan AND the FIFO baseline are validated + scored + gated the
 *    SAME way, so the before/after comparison is honest (P8) and the strawman's
 *    HARD-infeasibility is reported with its score intact (never bought out).
 */

// --- Wire DTOs (the stable public shapes) -----------------------------------

/** One validated, scored, feasibility-gated plan (recommended OR baseline). */
export interface ScoredPlanDto {
  readonly plan: LoadPlan;
  readonly validation: FeasibilityResult;
  readonly scores: ScoreResult;
  /** Derived from `isFeasible(validation)` ONLY — never from the score (P2). */
  readonly feasible: boolean;
}

/** The full `POST /plan` response: the recommended plan + the baseline strawman. */
export interface PlanResponseDto {
  readonly plan: LoadPlan;
  readonly baseline: ScoredPlanDto;
  readonly instructions: LoadingInstructions;
  readonly validation: FeasibilityResult;
  readonly scores: ScoreResult;
  readonly explanation: string;
  /** The recommended plan's verdict — `isFeasible(validation)` (P2). */
  readonly feasible: boolean;
}

/** A validation failure result (mapped to a 400). */
interface ParseFailure {
  readonly ok: false;
  readonly message: string;
}
/** A validation success result carrying the parsed, defaulted inputs. */
interface ParseSuccess {
  readonly ok: true;
  readonly packages: PlanningPackage[];
  readonly route: RouteStop[];
  readonly config: PlannerConfig;
}

/**
 * Validate the (untrusted) body's three parts with the domain's own zod schemas.
 * Returns the parsed inputs, or an error message for a 400. Reusing the domain
 * schemas keeps the planning contract single-sourced (DRY) — the API never
 * re-declares field rules. Reading each part off an `unknown` body via the
 * schemas means a non-object body fails closed (the array/object parses reject it).
 */
function parseBody(body: unknown): ParseSuccess | ParseFailure {
  const fields: { packages?: unknown; route?: unknown; config?: unknown } =
    typeof body === "object" && body !== null ? body : {};

  const packages = planningPackageSchema.array().safeParse(fields.packages);
  if (!packages.success) {
    return { ok: false, message: `invalid packages: ${packages.error.message}` };
  }
  const route = routeStopSchema.array().safeParse(fields.route);
  if (!route.success) {
    return { ok: false, message: `invalid route: ${route.error.message}` };
  }
  // `config` is optional; a partial config is merged over the spec defaults so a
  // caller may tune one knob without restating the whole config. We `.partial()`
  // the un-refined OBJECT schema here (a `.refine()`d schema is a `ZodEffects`
  // with no `.partial()`); the cross-field invariants (L7) are then enforced on
  // the MERGED result below — a single tuned edge can still invert the band.
  const config = plannerConfigObjectSchema.partial().safeParse(fields.config ?? {});
  if (!config.success) {
    return { ok: false, message: `invalid config: ${config.error.message}` };
  }
  // Re-validate the merged config through the FULL schema (cross-field rules).
  const merged = plannerConfigSchema.safeParse(mergeConfig(config.data));
  if (!merged.success) {
    return { ok: false, message: `invalid config: ${merged.error.message}` };
  }
  return {
    ok: true,
    packages: packages.data,
    route: route.data,
    config: merged.data,
  };
}

/** The zod-parsed partial config: every knob present-but-possibly-`undefined`. */
type PartialPlannerConfig = {
  readonly [K in keyof PlannerConfig]?: number | undefined;
};

/**
 * Merge a partial config over the spec defaults. Only keys with a DEFINED value
 * override a default — under `exactOptionalPropertyTypes` an explicit `undefined`
 * must NOT clobber a default, so we copy present-and-defined keys one by one.
 */
function mergeConfig(partial: PartialPlannerConfig): PlannerConfig {
  const merged: PlannerConfig = { ...DEFAULT_PLANNER_CONFIG };
  for (const key of Object.keys(partial) as (keyof PlannerConfig)[]) {
    const value = partial[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Run validate + score + the feasibility gate on ONE plan. The single helper
 * both the recommended plan and the baseline flow through (P8 / DRY), so they
 * are gated identically: `feasible` is `isFeasible(validation)` and NOTHING
 * else (P2) — the score is computed but never folded into the verdict.
 */
function gateAndScore(
  plan: LoadPlan,
  blocks: Parameters<typeof scorePlan>[1],
  route: readonly RouteStop[],
  config: PlannerConfig,
): ScoredPlanDto {
  const validation = validatePlan(plan, blocks, route, config);
  const scores = scorePlan(plan, blocks, route, config);
  return { plan, validation, scores, feasible: isFeasible(validation) };
}

/**
 * Register `POST /plan` on `app`. The handler is pure end-to-end (no DB), so the
 * route can be wired into any Fastify instance — the walking-skeleton `buildApp`
 * or the full `buildServer`.
 */
export function registerPlanRoutes(app: FastifyInstance): void {
  app.post(
    "/plan",
    async (req: FastifyRequest, reply: FastifyReply): Promise<PlanResponseDto> => {
      const parsed = parseBody(req.body);
      if (!parsed.ok) {
        return reply.code(400).send({ error: "bad_request", message: parsed.message });
      }
      const { packages, route, config } = parsed;

      // --- The pure pipeline on the SAME inputs -----------------------------
      const blocks = aggregate(packages, config);
      const plan = planLoad(blocks, route, config);
      const baseline = baselinePlan(blocks, route, config);

      // Validate + score BOTH plans through the one shared gate (P2 + P8).
      const recommended = gateAndScore(plan, blocks, route, config);
      const baselineScored = gateAndScore(baseline, blocks, route, config);

      return {
        plan: recommended.plan,
        baseline: baselineScored,
        instructions: instructions(plan, blocks),
        validation: recommended.validation,
        scores: recommended.scores,
        explanation: planExplanation(plan, blocks, route, config),
        // P2: the recommended plan's verdict is the validator's, independent of score.
        feasible: recommended.feasible,
      };
    },
  );
}
