import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { EpochRecommendation, EpochResult } from "@mm/optimizer";

import type { RollingOptimizerService } from "../optimizer/rolling-service.js";

/**
 * `GET /optimizer/recommendations` (OPT-04/05/06) — exposes the LATEST rolling
 * epoch's result: the candidate plan, its objective breakdown, and the
 * per-trailer recommendations.
 *
 * Design (KISS / DIP — smallest correct surface): a THIN read off the injected
 * {@link RollingOptimizerService} (the only stateful shell). It is READ-ONLY — it
 * never triggers an epoch or appends an event (the service owns the one write
 * path), so it cannot cause a premature side effect (threat T-04-12). Before the
 * first epoch runs it returns `204 No Content`.
 */

/** One recommendation on the wire (mirrors {@link EpochRecommendation}). */
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

function toDto(result: EpochResult): OptimizerRecommendationsDto {
  return {
    epochId: result.epochId,
    scopeHash: result.scopeHash,
    accepted: result.accepted,
    generated: result.generated,
    recommendations: result.recommendations.map((r) => ({
      trailerId: r.trailerId,
      planId: r.planId,
      feasible: r.feasible,
      objectiveCost: r.objectiveCost,
      breakdown: r.breakdown,
      frozen: r.frozen,
    })),
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
