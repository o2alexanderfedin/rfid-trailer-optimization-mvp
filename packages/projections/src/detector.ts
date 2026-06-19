import type { Kysely } from "kysely";
import type { DomainEvent } from "@mm/domain";
import {
  detectMissedUnload,
  detectWrongTrailer,
  type DetectionConfig,
  type MissedUnloadCandidate,
  type PlannedAssignment,
  type WrongTrailerCandidate,
  type ZoneEstimate,
} from "@mm/sensor-fusion";
import { exceptionId } from "./reducers/exceptions.js";
import type { ProjectionDb } from "./runner/inline.js";

/**
 * `detector.ts` — the DECISION-CRITICAL core of Phase 3 (SNS-04/05). It composes
 * the PLANNED layer (trailer-state assignment + dest hub) with the OBSERVED
 * layer (the fused zone estimates) through the PURE Plan-04 predicates, and — on
 * positive ABOVE-THRESHOLD disagreement — appends a `WrongTrailerDetected` /
 * `MissedUnloadDetected` event. The append is the ONLY write side effect; the
 * inline exceptions projection (`exceptionsReducer`) then surfaces it.
 *
 * ## Anti-P6 (the keystone, end-to-end)
 * Detection is driven ENTIRELY off the OBSERVED layer (the predicates iterate
 * observations and consult the plan by id). A package with NO read can never
 * appear in the output — absence is never "missing". Missed-unload is further
 * gated POST-departure: it runs only for hubs whose `TrailerDeparted` has fired.
 *
 * ## Idempotency / no-flood (T-03-16)
 * Each candidate maps to a STABLE `exceptionId`; the detector skips any candidate
 * already recorded (`readExistingExceptionIds`), so re-running detection never
 * re-appends — the feed cannot flood.
 *
 * ## Dependency inversion (acyclic DAG)
 * The detector takes its reads + its append through the `DetectorReads` port, so
 * `@mm/projections` never imports `@mm/event-store` (which depends on it). The
 * API composition root binds the port to real Postgres reads + `appendWithRetry`
 * (`makeProjectionReads`); tests bind it to in-memory snapshots.
 */

/** Build the events to append at a stream's current version (OCC retry-safe). */
export type AppendExceptions = (
  streamId: string,
  build: (currentVersion: number) => readonly DomainEvent[],
  occurredAt: Date,
) => Promise<unknown>;

/**
 * The detector's I/O port. Reads assemble the two layers + the gating inputs;
 * `append` is the sole write. All four reads return SNAPSHOTS so the pure core
 * (`planDetection`) stays deterministic and testable.
 */
export interface DetectorReads {
  /** PLANNED layer: one assignment per known package (trailer + dest hub). */
  readPlannedAssignments(): Promise<readonly PlannedAssignment[]>;
  /** OBSERVED layer: the latest fused zone estimate per (package, trailer). */
  readObserved(): Promise<readonly ZoneEstimate[]>;
  /** Hubs whose `TrailerDeparted` has fired — gates missed-unload detection. */
  readDepartedHubs(): Promise<readonly string[]>;
  /** Already-recorded exception ids — the dedupe set (no flood, T-03-16). */
  readExistingExceptionIds(): Promise<ReadonlySet<string>>;
  /** Append exception events (the ONLY write side effect), OCC-guarded. */
  readonly append: AppendExceptions;
}

/** Options for {@link runDetection}. */
export interface RunDetectionOptions {
  readonly config: DetectionConfig;
  /**
   * Domain time stamped on the appended exception events. Explicit (never
   * `Date.now()`) so the detector stays deterministic/replayable. Defaults to
   * the freshest `lastObservedAt` across the observations, or the epoch if none.
   */
  readonly occurredAt?: Date;
}

/** A candidate paired with its target stream + a builder for its domain event. */
interface PlannedAppend {
  readonly streamId: string;
  readonly exceptionId: string;
  readonly event: DomainEvent;
}

/**
 * The PURE detection core: given the two layers + the departed hubs + the
 * already-recorded exception ids, decide which exception events to append.
 * No I/O, no clock, no RNG — same inputs ⇒ same appends (auditable, testable).
 */
export function planDetection(
  plannedAssignments: readonly PlannedAssignment[],
  observed: readonly ZoneEstimate[],
  departedHubs: readonly string[],
  existingExceptionIds: ReadonlySet<string>,
  config: DetectionConfig,
): readonly PlannedAppend[] {
  const out: PlannedAppend[] = [];

  // SNS-04 wrong-trailer: over ALL current observations (anti-P6, obs-driven).
  for (const c of detectWrongTrailer(plannedAssignments, observed, config)) {
    pushUnique(out, existingExceptionIds, wrongTrailerAppend(c));
  }

  // SNS-05 missed-unload: ONLY for hubs that have departed (post-departure gate).
  // De-dup departed hubs deterministically so the same candidate cannot be
  // produced twice within one pass.
  for (const hub of [...new Set(departedHubs)].sort(compareStr)) {
    for (const c of detectMissedUnload(plannedAssignments, observed, hub, config)) {
      pushUnique(out, existingExceptionIds, missedUnloadAppend(c));
    }
  }

  return out;
}

/**
 * `runDetection` — read the two layers, run the pure detection core, and append
 * each new exception event (the ONLY side effect). Idempotent: already-recorded
 * candidates are skipped, so re-running never floods the feed.
 */
export async function runDetection(
  reads: DetectorReads,
  options: RunDetectionOptions,
): Promise<readonly DomainEvent[]> {
  const [plannedAssignments, observed, departedHubs, existing] = await Promise.all([
    reads.readPlannedAssignments(),
    reads.readObserved(),
    reads.readDepartedHubs(),
    reads.readExistingExceptionIds(),
  ]);

  const appends = planDetection(
    plannedAssignments,
    observed,
    departedHubs,
    existing,
    options.config,
  );
  if (appends.length === 0) return [];

  const occurredAt = options.occurredAt ?? freshestObservedAt(observed);

  const appended: DomainEvent[] = [];
  for (const a of appends) {
    await reads.append(a.streamId, () => [a.event], occurredAt);
    appended.push(a.event);
  }
  return appended;
}

/** Bind the `DetectorReads` ports (except append) to real projection reads. */
export interface ProjectionReadDeps {
  /** Resolve each package's destination hub (PLANNED, not a projection). */
  readDestHub: (packageId: string) => string | undefined;
  /** The append side, injected so this package never imports the event store. */
  readonly append: AppendExceptions;
}

/**
 * Adapter: build a `DetectorReads` from a live `Kysely<ProjectionDb>` handle.
 * Assembles the PLANNED layer from `trailer_state.assignedPackageIds` (the
 * trailer a package was loaded onto) + the injected `readDestHub`; reads the
 * OBSERVED layer from `zone_estimate`; derives departed hubs + the dedupe set
 * from the persisted projections. Used by the API/sim composition root.
 */
export function makeProjectionReads(
  db: Kysely<ProjectionDb>,
  deps: ProjectionReadDeps,
): DetectorReads {
  // The PLANNED dest hub is not a projection (PackageCreated.destHubId is not
  // folded into any read model); the API root injects `readDestHub` from a
  // package index (a tiny PackageCreated fold) — DIP keeps this package acyclic.
  return {
    readPlannedAssignments: async () => {
      const trailers = await db.selectFrom("trailer_state").selectAll().execute();
      const out: PlannedAssignment[] = [];
      for (const t of trailers) {
        for (const packageId of t.assigned_package_ids) {
          const destHubId = deps.readDestHub(packageId);
          if (destHubId === undefined) continue; // unknown dest ⇒ cannot plan
          out.push({ packageId, plannedTrailerId: t.trailer_id, destHubId });
        }
      }
      return out;
    },
    readObserved: async () => {
      const rows = await db.selectFrom("zone_estimate").selectAll().execute();
      return rows.map((r) => ({
        packageId: r.package_id,
        trailerId: r.trailer_id,
        estimatedZone: asZone(r.estimated_zone),
        confidence: r.confidence,
        posterior: asDistribution(r.posterior),
        lastReliableCheckpoint: r.last_reliable_checkpoint,
        lastObservedAt: toIso(r.last_observed_at),
      }));
    },
    readDepartedHubs: async () => {
      // Post-departure gate (SNS-05): a trailer in `in_transit` HAS departed its
      // last hub. trailer-state does not retain WHICH hub, so this adapter gates
      // on the destinations of packages still aboard an in-transit trailer — the
      // hubs a still-loaded package was meant to unload at. This is the pragmatic
      // MVP gate; Plan 07 drives detection from the sim loop and can inject the
      // EXACT just-departed hub via this same `readDepartedHubs` port (DIP), so
      // the gate tightens with zero change to the detector core.
      const trailers = await db.selectFrom("trailer_state").selectAll().execute();
      const hubs = new Set<string>();
      for (const t of trailers) {
        if (t.status !== "in_transit") continue;
        for (const packageId of t.assigned_package_ids) {
          const destHubId = deps.readDestHub(packageId);
          if (destHubId !== undefined) hubs.add(destHubId);
        }
      }
      return [...hubs];
    },
    readExistingExceptionIds: async () => {
      const rows = await db.selectFrom("exceptions").select("exception_id").execute();
      return new Set(rows.map((r) => r.exception_id));
    },
    append: deps.append,
  };
}

// --- candidate -> append mapping --------------------------------------------

function wrongTrailerAppend(c: WrongTrailerCandidate): PlannedAppend {
  const event: DomainEvent = {
    type: "WrongTrailerDetected",
    schemaVersion: 1,
    payload: {
      packageId: c.packageId,
      observedTrailerId: c.observedTrailerId,
      plannedTrailerId: c.plannedTrailerId,
      confidence: c.confidence,
      severity: c.severity,
      recommendedAction: c.recommendedAction,
    },
  };
  return {
    streamId: `package-${c.packageId}`,
    exceptionId: exceptionId("wrong-trailer", c.packageId, c.observedTrailerId, null),
    event,
  };
}

function missedUnloadAppend(c: MissedUnloadCandidate): PlannedAppend {
  const event: DomainEvent = {
    type: "MissedUnloadDetected",
    schemaVersion: 1,
    payload: {
      packageId: c.packageId,
      trailerId: c.trailerId,
      hubId: c.hubId,
      confidence: c.confidence,
      severity: c.severity,
      recommendedAction: c.recommendedAction,
    },
  };
  return {
    streamId: `package-${c.packageId}`,
    exceptionId: exceptionId("missed-unload", c.packageId, c.trailerId, c.hubId),
    event,
  };
}

/** Push a candidate iff its exceptionId is not already recorded (no flood). */
function pushUnique(
  out: PlannedAppend[],
  existing: ReadonlySet<string>,
  candidate: PlannedAppend,
): void {
  if (existing.has(candidate.exceptionId)) return;
  // Guard against an in-pass duplicate (e.g. two observations of the same pkg).
  if (out.some((a) => a.exceptionId === candidate.exceptionId)) return;
  out.push(candidate);
}

/** The freshest observed timestamp, or the epoch if no observations (P3). */
function freshestObservedAt(observed: readonly ZoneEstimate[]): Date {
  let max = 0;
  for (const o of observed) {
    const ms = Date.parse(o.lastObservedAt);
    if (Number.isFinite(ms) && ms > max) max = ms;
  }
  return new Date(max);
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

const ZONE_VALUES = new Set(["rear", "middle", "nose"]);
function asZone(value: string): "rear" | "middle" | "nose" {
  if (ZONE_VALUES.has(value)) return value as "rear" | "middle" | "nose";
  throw new Error(`Unknown zone in projection row: ${value}`);
}

function asDistribution(
  value: Readonly<Record<string, number>>,
): Readonly<Record<"rear" | "middle" | "nose", number>> {
  return { rear: value.rear ?? 0, middle: value.middle ?? 0, nose: value.nose ?? 0 };
}
