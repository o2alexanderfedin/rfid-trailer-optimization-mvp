import type { Kysely } from "kysely";
import type { Database } from "@mm/event-store";
import { appendWithRetry } from "@mm/event-store";
import type { DomainEvent, PlanAccepted, PlanGenerated } from "@mm/domain";
import {
  DEFAULT_OBJECTIVE_WEIGHTS,
  runEpoch,
  type Epoch,
  type EpochInput,
  type EpochResult,
  type ObjectiveWeights,
} from "@mm/optimizer";

/**
 * `@mm/api` — `RollingOptimizerService`: the ONLY stateful, side-effecting part
 * of the rolling optimizer (OPT-04/05/06).
 *
 * The pure `runEpoch` core takes data in and returns data out; this thin SHELL is
 * the one place that touches the world. Per epoch it:
 *
 *  1. Calls `runEpoch(epoch, input, weights)` over a `structuredClone` twin — the
 *     EVALUATION phase, which writes NOTHING (OPT-04: zero side effects until
 *     accept). No projection row changes, no event is appended here.
 *  2. MEMOIZES the `EpochResult` by `${epochId}:${scopeHash}` — feeding the same
 *     `(epoch, scope)` twice returns the cached result and appends the plan AT
 *     MOST ONCE (the OPT-06 anti-thrash idempotency: identical input ⇒ identical
 *     plan, committed once).
 *  3. On `accepted != null`, appends EXACTLY ONE `PlanAccepted` (the ONE
 *     operational side effect) — preceded by the observational `PlanGenerated`
 *     record — to the trailer's optimizer stream, via the Phase-1
 *     optimistic-concurrency writer (`appendWithRetry` retries on
 *     `ConcurrencyError`). The optimizer is thus a well-behaved concurrent
 *     event-store writer (threat T-04-14).
 *
 * The epoch clock (`epoch.nowMin`) comes from sim/event time — the service never
 * reads `Date.now()` into the optimization path; the only DB clock is
 * `recorded_at`. `occurredAt` is the deterministic, epoch-derived stamp the pure
 * core already put on the payloads.
 */

/** The stream a trailer's plan-lifecycle events live on (one writer per trailer). */
function planStreamId(trailerId: string): string {
  return `optimizer-${trailerId}`;
}

/** A committed-epoch record: the result plus whether it produced a NEW append. */
export interface RollingEpochOutcome {
  /** The (possibly memoized) pure epoch result. */
  readonly result: EpochResult;
  /** True when THIS call appended a `PlanAccepted` (false when memoized/no-accept). */
  readonly committed: boolean;
}

/** Construction deps for {@link RollingOptimizerService} (DIP — inject the store). */
export interface RollingOptimizerDeps {
  readonly db: Kysely<Database>;
  /** §12 objective weights (defaults to the optimizer's demo weights). */
  readonly weights?: ObjectiveWeights;
}

export class RollingOptimizerService {
  private readonly db: Kysely<Database>;
  private readonly weights: ObjectiveWeights;
  /** `${epochId}:${scopeHash}` → the committed result (idempotency memo). */
  private readonly memo = new Map<string, EpochResult>();
  /** The most recent epoch result (what the API endpoint surfaces). */
  private latest: EpochResult | null = null;

  constructor(deps: RollingOptimizerDeps) {
    this.db = deps.db;
    this.weights = deps.weights ?? DEFAULT_OBJECTIVE_WEIGHTS;
  }

  /** The latest epoch result the endpoint exposes (`null` before the first run). */
  latestResult(): EpochResult | null {
    return this.latest;
  }

  /**
   * Run ONE rolling epoch over the given events + twin snapshot. The evaluation
   * (`runEpoch`) has NO side effects; only an `accepted` plan triggers the single
   * `PlanAccepted` append. Idempotent per `(epochId, scopeHash)`.
   */
  async runOnce(epoch: Epoch, input: EpochInput): Promise<RollingEpochOutcome> {
    // 1. EVALUATE — pure, zero side effects (OPT-04). We compute the scopeHash via
    //    the result so the memo key matches the idempotency contract exactly.
    const fresh = runEpoch(epoch, input, this.weights);
    const key = `${epoch.epochId}:${fresh.scopeHash}`;

    // 2. IDEMPOTENCY — a memoized epoch never re-appends (anti-P7).
    const memoized = this.memo.get(key);
    if (memoized !== undefined) {
      this.latest = memoized;
      return { result: memoized, committed: false };
    }

    // 3. COMMIT — on accept, append the ONE PlanAccepted (+ the PlanGenerated
    //    record) via the optimistic-concurrency writer. Nothing else writes.
    let committed = false;
    if (fresh.accepted !== null && fresh.generated !== null) {
      await this.appendPlan(fresh.generated, fresh.accepted);
      committed = true;
    }

    this.memo.set(key, fresh);
    this.latest = fresh;
    return { result: fresh, committed };
  }

  /**
   * Append the observational `PlanGenerated` then the operational `PlanAccepted`
   * for an accepted plan, to the trailer's optimizer stream, in ONE retrying
   * append (atomic — both land or neither, no partial). The shell is a concurrent
   * writer: a `ConcurrencyError` triggers reload + retry (Phase-1 contract).
   */
  private async appendPlan(
    generated: PlanGenerated["payload"],
    accepted: PlanAccepted["payload"],
  ): Promise<void> {
    const stream = planStreamId(accepted.trailerId);
    const events: readonly DomainEvent[] = [
      { type: "PlanGenerated", schemaVersion: 1, payload: generated },
      { type: "PlanAccepted", schemaVersion: 1, payload: accepted },
    ];
    // `occurredAt` for `recorded_at`-independent ordering is the DB write moment;
    // the DOMAIN clock (`payload.occurredAt`) is the epoch-derived, deterministic
    // stamp already on the events — never overwritten here.
    await appendWithRetry(this.db, stream, () => events, new Date(accepted.occurredAt));
  }
}
