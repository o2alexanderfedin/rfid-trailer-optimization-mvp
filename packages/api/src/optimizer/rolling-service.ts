import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "@mm/event-store";
import { appendWithRetry } from "@mm/event-store";
import type { ProjectionDb } from "@mm/projections";
import type {
  DomainEvent,
  PlanAccepted,
  PlanGenerated,
  PlanSuperseded,
} from "@mm/domain";
import {
  DEFAULT_OBJECTIVE_WEIGHTS,
  detectAffectedScope,
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
 *  2. On accept, DURABLY CLAIMS the `(horizonStart, horizonEnd, scopeHash)`
 *     epoch in the `optimizer_idempotency` Postgres table via `INSERT ... ON
 *     CONFLICT DO NOTHING RETURNING` — an atomic compare-and-set at the DB. A
 *     duplicate claim RETURNs 0 rows and the append is skipped (the OPT-06
 *     anti-thrash idempotency: identical `(epoch, scope)` ⇒ identical plan,
 *     committed AT MOST ONCE). Unlike the prior in-memory memo (CONT-04c, lost on
 *     restart — v1.0 debt), the durable row SURVIVES a process restart,
 *     so a restart at the same sim-time + scope re-claims the SAME row and never
 *     double-commits (FLOW-04). A `status` column (PROCESSING/COMPLETED/FAILED)
 *     supports crash-mid-epoch recovery.
 *  3. On a fresh claim, appends `PlanGenerated`, `PlanAccepted`, and — when a
 *     PRIOR plan for this trailer's stream is being replaced — a `PlanSuperseded`
 *     (FLOW-04 / D-21-1) carrying EXACTLY the prior plan's staged package set, all
 *     in ONE atomic `appendWithRetry` batch (the Phase-1 optimistic-concurrency
 *     writer retries on `ConcurrencyError`). The co-committed `PlanSuperseded` is
 *     what the hub-inventory delete-then-apply reducer wipes from `staged` — no
 *     double-count, no stranded old-plan items.
 *
 * The epoch clock (`epoch.nowMin`) comes from sim/event time — the service never
 * reads `Date.now()` into the optimization path; the only DB clock is
 * `recorded_at` / the idempotency table's `claimed_at`/`completed_at`.
 * `occurredAt` is the deterministic, epoch-derived stamp the pure core already
 * put on the payloads.
 */

/** The stream a trailer's plan-lifecycle events live on (one writer per trailer). */
function planStreamId(trailerId: string): string {
  return `optimizer-${trailerId}`;
}

/** A committed-epoch record: the result plus whether it produced a NEW append. */
export interface RollingEpochOutcome {
  /** The pure epoch result. */
  readonly result: EpochResult;
  /** True when THIS call appended a `PlanAccepted` (false when claimed/no-accept). */
  readonly committed: boolean;
}

/**
 * The pure epoch compute, behind a DIP port so it can run INLINE (default) or be
 * offloaded to a `worker_threads` worker (Task 6) with NO change to the shell's
 * claim/append logic. Identical signature in both modes — only the transport
 * differs. `Promise`-returning so the worker round-trip is async; the inline
 * default just wraps the synchronous `runEpoch` in a resolved promise.
 */
export type RunEpochFn = (
  epoch: Epoch,
  input: EpochInput,
  weights: ObjectiveWeights,
) => Promise<EpochResult>;

/** Construction deps for {@link RollingOptimizerService} (DIP — inject the store). */
export interface RollingOptimizerDeps {
  readonly db: Kysely<Database>;
  /** §12 objective weights (defaults to the optimizer's demo weights). */
  readonly weights?: ObjectiveWeights;
  /**
   * The epoch compute transport (DIP). Default: INLINE — `(e,i,w) =>
   * Promise.resolve(runEpoch(e,i,w))` — byte-for-byte the current synchronous
   * behavior, so every existing optimizer/loop/integration test runs unchanged.
   * The demo server injects a worker-backed implementation (Task 6/7).
   */
  readonly runEpochFn?: RunEpochFn;
}

export class RollingOptimizerService {
  private readonly db: Kysely<Database>;
  private readonly weights: ObjectiveWeights;
  /** The epoch compute transport (inline by default; worker when injected). */
  private readonly runEpochFn: RunEpochFn;
  /**
   * Per trailer-plan stream (`optimizer-${trailerId}`) → the package ids the
   * MOST RECENT accepted plan staged for that trailer. The NEXT accept on the same
   * stream emits a `PlanSuperseded` carrying this PRIOR set as
   * `supersededPackageIds` (FLOW-04 / D-21-1) — exactly the set the hub-inventory
   * delete-then-apply reducer wipes from `staged`. Bounded by the trailer fleet
   * size (one entry per trailer), so it cannot grow without bound under continuous
   * operation. (The cross-restart idempotency that the in-memory memo could NOT
   * provide now lives in the durable `optimizer_idempotency` table; this map only
   * carries the per-trailer prior-staged set used to build the supersession event.)
   */
  private readonly priorStagedByStream = new Map<string, readonly string[]>();
  /** The most recent epoch result (what the API endpoint surfaces). */
  private latest: EpochResult | null = null;
  /**
   * The most recent epoch result that produced non-empty recommendations.
   * When the latest result is an empty-scope tick (no trailer events), the
   * API endpoint surfaces this non-empty result instead so the demo always
   * shows the most recent meaningful plan output.
   */
  private latestNonEmpty: EpochResult | null = null;

  constructor(deps: RollingOptimizerDeps) {
    this.db = deps.db;
    this.weights = deps.weights ?? DEFAULT_OBJECTIVE_WEIGHTS;
    this.runEpochFn =
      deps.runEpochFn ?? ((e, i, w) => Promise.resolve(runEpoch(e, i, w)));
  }

  /**
   * The latest epoch result the endpoint exposes.
   * Returns the most recent result with non-empty recommendations, falling
   * back to the latest result (which may have empty recommendations).
   * Returns `null` before the first run.
   */
  latestResult(): EpochResult | null {
    return this.latestNonEmpty ?? this.latest;
  }

  /**
   * FLOW-04 — the count of durable idempotency claims in the
   * `optimizer_idempotency` table (a testability surface, no functional impact).
   * Backed by Postgres (not in-memory), so it is inherently bounded by the number
   * of DISTINCT `(horizon, scope)` epochs ever committed — the durable replacement
   * for the v1.0 in-memory memo cap.
   */
  async claimCount(): Promise<number> {
    const row = await this.db
      .selectFrom("optimizer_idempotency")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .executeTakeFirst();
    return row === undefined ? 0 : Number(row.n);
  }

  /**
   * Run ONE rolling epoch over the given events + twin snapshot. The evaluation
   * (`runEpoch`) has NO side effects; only an `accepted` plan triggers a durable
   * `(horizon, scopeHash)` claim and, on a FRESH claim, the single
   * `PlanAccepted` append (co-committed with `PlanGenerated` + an optional
   * `PlanSuperseded`). Idempotent per `(horizonStart, horizonEnd, scopeHash)` —
   * across restarts (the durable table).
   */
  async runOnce(epoch: Epoch, input: EpochInput): Promise<RollingEpochOutcome> {
    // 1. EVALUATE — pure, zero side effects (OPT-04). The compute runs through the
    //    injected transport (inline by default; a worker thread in the demo); the
    //    result is plain data either way (structured-clone-safe).
    const fresh = await this.runEpochFn(epoch, input, this.weights);

    // 2. No accept ⇒ NO side effect, NO claim. A non-accepting epoch has nothing
    //    to dedupe (it writes nothing), so it never touches the durable table.
    if (fresh.accepted === null || fresh.generated === null) {
      this.recordLatest(fresh);
      return { result: fresh, committed: false };
    }

    // 3. DURABLE IDEMPOTENCY CLAIM — atomically claim this epoch's (horizon,
    //    scopeHash) at the DB. An empty RETURNING means another run/worker (or a
    //    pre-restart run) already claimed it ⇒ skip the append (committed:false).
    const scope = detectAffectedScope(input.events, epoch);
    const claimed = await this.claimEpoch(
      scope.horizonStartMin,
      scope.horizonEndMin,
      fresh.scopeHash,
      fresh.accepted.planId,
    );
    if (!claimed) {
      this.recordLatest(fresh);
      return { result: fresh, committed: false };
    }

    // 4. COMMIT — append the plan (+ PlanSuperseded for any prior plan on this
    //    stream) in ONE atomic batch, then mark the claim COMPLETED (or FAILED on
    //    error, for crash-mid-epoch recovery).
    try {
      await this.appendPlan(fresh.generated, fresh.accepted);
      await this.finishClaim(
        scope.horizonStartMin,
        scope.horizonEndMin,
        fresh.scopeHash,
        "COMPLETED",
      );
    } catch (err) {
      await this.finishClaim(
        scope.horizonStartMin,
        scope.horizonEndMin,
        fresh.scopeHash,
        "FAILED",
      );
      throw err;
    }

    this.recordLatest(fresh);
    return { result: fresh, committed: true };
  }

  /** Track `latest` / `latestNonEmpty` for the API endpoint (no side effects). */
  private recordLatest(fresh: EpochResult): void {
    this.latest = fresh;
    if (fresh.recommendations.length > 0) {
      this.latestNonEmpty = fresh;
    }
  }

  /**
   * Atomically CLAIM an epoch in `optimizer_idempotency`: `INSERT ... ON CONFLICT
   * (horizon_start, horizon_end, scope_hash) DO NOTHING RETURNING`. Returns true
   * when THIS call inserted the row (a fresh claim ⇒ proceed to append), false
   * when the row already existed (already claimed — possibly by a pre-restart run
   * ⇒ skip the append). All values are parameterized (no string concatenation).
   */
  private async claimEpoch(
    horizonStart: number,
    horizonEnd: number,
    scopeHash: string,
    planId: string,
  ): Promise<boolean> {
    const inserted = await this.db
      .insertInto("optimizer_idempotency")
      .values({
        horizon_start: horizonStart,
        horizon_end: horizonEnd,
        scope_hash: scopeHash,
        status: "PROCESSING",
        plan_id: planId,
      })
      .onConflict((oc) =>
        oc.columns(["horizon_start", "horizon_end", "scope_hash"]).doNothing(),
      )
      .returning("scope_hash")
      .executeTakeFirst();
    return inserted !== undefined;
  }

  /** Transition a claimed epoch to COMPLETED/FAILED (crash-mid-epoch recovery). */
  private async finishClaim(
    horizonStart: number,
    horizonEnd: number,
    scopeHash: string,
    status: "COMPLETED" | "FAILED",
  ): Promise<void> {
    await this.db
      .updateTable("optimizer_idempotency")
      .set({ status, completed_at: sql`now()` })
      .where("horizon_start", "=", horizonStart)
      .where("horizon_end", "=", horizonEnd)
      .where("scope_hash", "=", scopeHash)
      .execute();
  }

  /**
   * Append the observational `PlanGenerated` then the operational `PlanAccepted`
   * for an accepted plan — and, when this plan REPLACES a prior accepted plan on
   * the same trailer stream, a `PlanSuperseded` carrying EXACTLY the prior plan's
   * staged package set (FLOW-04 / D-21-1) — to the trailer's optimizer stream, in
   * ONE retrying append (atomic — all land or none, no partial). The shell is a
   * concurrent writer: a `ConcurrencyError` triggers reload + retry (Phase-1
   * contract).
   */
  private async appendPlan(
    generated: PlanGenerated["payload"],
    accepted: PlanAccepted["payload"],
  ): Promise<void> {
    const stream = planStreamId(accepted.trailerId);

    // The package set THIS plan stages for the trailer = the trailer's current
    // `assigned_package_ids` projection (package-granular; the same set the
    // optimizer's TwinBlocks are built from). This is the EXACT set hub-inventory's
    // delete-then-apply wipes when the NEXT plan supersedes this one.
    const stagedNow = await this.stagedPackageIdsFor(accepted.trailerId);
    const priorStaged = this.priorStagedByStream.get(stream);

    const events: DomainEvent[] = [
      { type: "PlanGenerated", schemaVersion: 1, payload: generated },
      { type: "PlanAccepted", schemaVersion: 1, payload: accepted },
    ];

    // FLOW-04 / D-21-1: emit PlanSuperseded ONLY when a prior accepted plan exists
    // for this trailer/scope stream — carrying the prior plan's exact staged set so
    // the reducer wipes precisely it (no more, no less). The FIRST plan for a
    // trailer has no prior ⇒ no PlanSuperseded.
    if (priorStaged !== undefined) {
      const superseded: PlanSuperseded["payload"] = {
        epochId: accepted.epochId,
        scopeHash: accepted.scopeHash,
        priorPlanId: this.priorPlanIdByStream.get(stream) ?? accepted.planId,
        trailerId: accepted.trailerId,
        supersededPackageIds: [...priorStaged],
        reason: `superseded by ${accepted.planId}`,
        occurredAt: accepted.occurredAt,
      };
      events.push({ type: "PlanSuperseded", schemaVersion: 1, payload: superseded });
    }

    // `occurredAt` for `recorded_at`-independent ordering is the DB write moment;
    // the DOMAIN clock (`payload.occurredAt`) is the epoch-derived, deterministic
    // stamp already on the events — never overwritten here.
    await appendWithRetry(this.db, stream, () => events, new Date(accepted.occurredAt));

    // Record THIS plan as the prior for the NEXT supersession on this stream.
    this.priorStagedByStream.set(stream, stagedNow);
    this.priorPlanIdByStream.set(stream, accepted.planId);
  }

  /** Per-stream prior accepted planId (the audit `priorPlanId` on PlanSuperseded). */
  private readonly priorPlanIdByStream = new Map<string, string>();

  /**
   * The package ids a trailer currently stages = its `trailer_state.assigned_
   * package_ids` projection (JSONB array of package ids). Deterministic read; an
   * unseen/empty trailer yields `[]`.
   */
  private async stagedPackageIdsFor(trailerId: string): Promise<readonly string[]> {
    // `trailer_state` is a PROJECTION table (in ProjectionDb, not the event-store
    // Database); the live db handle carries both (the server constructs it that
    // way). Read it through the combined type — the same pattern twin-snapshot uses.
    const projectionDb = this.db as unknown as Kysely<Database & ProjectionDb>;
    const row = await projectionDb
      .selectFrom("trailer_state")
      .select("assigned_package_ids")
      .where("trailer_id", "=", trailerId)
      .executeTakeFirst();
    if (row === undefined) return [];
    const ids: unknown = row.assigned_package_ids;
    return Array.isArray(ids) ? (ids as string[]) : [];
  }
}
