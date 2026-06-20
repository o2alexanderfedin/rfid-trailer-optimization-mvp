import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { EpochRecommendation, EpochResult } from "@mm/optimizer";
import type { RepairKind } from "@mm/optimizer"; // used by RepairRecDto

import type { RollingOptimizerService } from "../optimizer/rolling-service.js";

/**
 * `GET /optimizer/recommendations` (OPT-04/05/06/07) — exposes the LATEST
 * rolling epoch's result: the candidate plan, its objective breakdown, the
 * per-trailer recommendations, and — when the epoch surfaces them — the
 * ranked split/reassign/hold/over-carry repair recommendations per trailer.
 *
 * Design (KISS / DIP — smallest correct surface): a THIN read off the injected
 * {@link RollingOptimizerService} (the only stateful shell). It is READ-ONLY — it
 * never triggers an epoch or appends an event (the service owns the one write
 * path), so it cannot cause a premature side effect (threat T-04-12). Before the
 * first epoch runs it returns `204 No Content`.
 *
 * Repair recommendations (OPT-07):
 *  `EpochRecommendation` may optionally carry a `repairRecommendations` array
 *  populated by `localRepair` for infeasible trailers. When present, each entry
 *  carries `kind` (split|reassign|hold|overCarry), a human-readable `rationale`,
 *  and a SEPARATE `feasible` flag (anti-P2: feasibility is never folded into the
 *  kind or cost). The route surfaces these as-is — it does not re-run repair.
 */

/**
 * One ranked repair recommendation surfaced by `localRepair` (OPT-07).
 * Feasibility is a SEPARATE field (anti-P2): a low-cost repair is never assumed
 * feasible; the gate verdict travels alongside the cost/kind.
 */
export interface RepairRecDto {
  /** The §17.4 recovery action. */
  readonly kind: RepairKind;
  /** Human-readable explanation (§17.4 rationale — anti-repudiation). */
  readonly rationale: string;
  /** Phase-2 HARD gate verdict — kept DISTINCT from `kind` and cost (anti-P2). */
  readonly feasible: boolean;
}

/**
 * One recommendation on the wire (mirrors {@link EpochRecommendation}).
 *
 * When the epoch runs `localRepair` for an infeasible trailer, `repairRecommendations`
 * carries the ranked split/reassign/hold/overCarry options. Its absence means the
 * trailer was frozen, feasible, or the epoch skipped repair generation.
 */
export interface RecommendationDto {
  readonly trailerId: string;
  readonly planId: string;
  /** Phase-2 HARD verdict — kept distinct from `objectiveCost` (anti-P2). */
  readonly feasible: boolean;
  readonly objectiveCost: number;
  /** Per-term objective contribution breakdown (explainability). */
  readonly breakdown: EpochRecommendation["breakdown"];
  /** Whether the trailer was frozen (skipped) this epoch (anti-P7). */
  readonly frozen: boolean;
  /**
   * Ranked repair recommendations from `localRepair` (OPT-07).
   * Present only when the epoch ran repair for this trailer (infeasible plans);
   * absent (`undefined`) for feasible or frozen trailers.
   */
  readonly repairRecommendations?: readonly RepairRecDto[];
}

/** The `GET /optimizer/recommendations` response: the latest epoch result. */
export interface OptimizerRecommendationsDto {
  readonly epochId: string;
  readonly scopeHash: string;
  /** The accepted plan's identifiers, or `null` when nothing was accepted. */
  readonly accepted: EpochResult["accepted"];
  /** The candidate plan record (objective + feasibility), or `null`. */
  readonly generated: EpochResult["generated"];
  readonly recommendations: readonly RecommendationDto[];
}

function toRepairDto(rec: EpochRecommendation): RecommendationDto {
  const base: RecommendationDto = {
    trailerId: rec.trailerId,
    planId: rec.planId,
    feasible: rec.feasible,
    objectiveCost: rec.objectiveCost,
    breakdown: rec.breakdown,
    frozen: rec.frozen,
  };

  // Surface repair recs if the epoch populated them (OPT-07).
  // EpochRecommendation now carries repairRecommendations natively (FIX 1).
  if (rec.repairRecommendations !== undefined && rec.repairRecommendations.length > 0) {
    return {
      ...base,
      repairRecommendations: rec.repairRecommendations.map((r) => ({
        kind: r.kind,
        rationale: r.rationale,
        feasible: r.feasible,
      })),
    };
  }
  return base;
}

function toDto(result: EpochResult): OptimizerRecommendationsDto {
  return {
    epochId: result.epochId,
    scopeHash: result.scopeHash,
    accepted: result.accepted,
    generated: result.generated,
    recommendations: result.recommendations.map(toRepairDto),
  };
}

/**
 * Register `GET /optimizer/recommendations` on `app`, reading from the injected
 * rolling service. Kept a factory (no global state) so the same route wires into
 * any Fastify instance the composition root builds.
 */
export function registerOptimizerRoutes(
  app: FastifyInstance,
  service: RollingOptimizerService,
): void {
  app.get(
    "/optimizer/recommendations",
    async (
      _req: FastifyRequest,
      reply: FastifyReply,
    ): Promise<OptimizerRecommendationsDto | undefined> => {
      const latest = service.latestResult();
      if (latest === null) {
        return reply.code(204).send();
      }
      return toDto(latest);
    },
  );
}
