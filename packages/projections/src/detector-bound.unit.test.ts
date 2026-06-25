import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";
import {
  DEFAULT_DETECTION_CONFIG,
  type PlannedAssignment,
  type ZoneEstimate,
} from "@mm/sensor-fusion";
import {
  ACTIVE_TRAILER_STATUSES,
  type DetectorReads,
  isActiveTrailerStatus,
  runDetection,
} from "./index.js";

/**
 * Plan 21-06 (FLOW-04) — DETECTION COST IS BOUNDED BY THE ACTIVE SET.
 *
 * Under continuous bidirectional freight, the `zone_estimate` projection grows
 * with EVERY (package, trailer) ever observed. The unscoped reads made detection
 * cost scale with total-ever state (the detection-cost-scales-with-state debt).
 * `makeProjectionReads` now scopes its reads to ACTIVE (`in_transit`) trailers
 * (A3: a not-yet-terminal predicate over the existing `status` column — no
 * schema change). This suite witnesses, in the unit lane, that the scoping:
 *
 *  (1) PERF: keeps `runDetection` cost tracking the active set, not the inactive
 *      total — a 5k-mostly-inactive state costs ~the same as the active subset
 *      alone (ratio-based, bounded to ≤5k per GATE-HYGIENE).
 *  (2) EQUIVALENCE: produces EXACTLY the same exceptions for the active set as a
 *      reference unscoped read over that same active set — scoping changes COST,
 *      not RESULTS.
 *
 * The scoping is modelled here EXACTLY as the SQL adapter performs it: an
 * observation is read iff its trailer is `in_transit` (the active set), mirroring
 * `WHERE trailer_id IN (SELECT trailer_id FROM trailer_state WHERE status IN
 * (...active...))`. We drive the REAL pure `runDetection` core so the assertion
 * is over genuine detection behaviour, not a re-implementation.
 */

const T0 = Date.parse("2026-06-01T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

interface TrailerRow {
  readonly trailerId: string;
  readonly status: string;
}

function obs(packageId: string, trailerId: string, confidence: number): ZoneEstimate {
  return {
    packageId,
    trailerId,
    estimatedZone: "middle",
    confidence,
    posterior: { rear: 0.1, middle: confidence, nose: 0.9 - confidence },
    lastReliableCheckpoint: null,
    lastObservedAt: at(0),
  };
}

function plan(
  packageId: string,
  plannedTrailerId: string,
  destHubId: string,
): PlannedAssignment {
  return { packageId, plannedTrailerId, destHubId };
}

/**
 * A `DetectorReads` over in-memory snapshots that scopes its observed read to
 * the ACTIVE-trailer set when `scope` is true — mirroring the SQL adapter's
 * `WHERE trailer_id IN (active)` filter (and the planned/departed reads filtered
 * to active trailers). The append is a no-op sink (we read the planned appends
 * via the returned events).
 */
function harness(
  trailers: readonly TrailerRow[],
  planned: readonly PlannedAssignment[],
  observed: readonly ZoneEstimate[],
  departedHubs: readonly string[],
  scope: boolean,
): DetectorReads {
  const activeTrailerIds = new Set(
    trailers.filter((t) => isActiveTrailerStatus(t.status)).map((t) => t.trailerId),
  );
  // PLANNED layer: scope to assignments on an active trailer (mirrors the SQL
  // `trailer_state WHERE status IN (active)` filter).
  const activePlanned = scope
    ? planned.filter(
        (p) => p.plannedTrailerId !== null && activeTrailerIds.has(p.plannedTrailerId),
      )
    : planned;
  // OBSERVED layer: scope by the ACTIVE PACKAGE set (packages aboard an active
  // trailer) — NOT the observed trailer's status — mirroring the SQL adapter's
  // `zone_estimate WHERE package_id IN (active packages)`. The observed trailer
  // may be ANY trailer (wrong-trailer is a cross-trailer observation), so the
  // observed trailerId is never a scope key (FLOW-04 fix).
  const activePackageIds = new Set(activePlanned.map((p) => p.packageId));
  const activeObserved = scope
    ? observed.filter((o) => activePackageIds.has(o.packageId))
    : observed;

  return {
    readPlannedAssignments: () => Promise.resolve(activePlanned),
    readObserved: () => Promise.resolve(activeObserved),
    readDepartedHubs: () => Promise.resolve(departedHubs),
    readExistingExceptionIds: () => Promise.resolve(new Set<string>()),
    append: () => Promise.resolve(),
  };
}

/** Run `runDetection` and return the appended exception events. */
async function detect(reads: DetectorReads): Promise<readonly DomainEvent[]> {
  return runDetection(reads, { config: DEFAULT_DETECTION_CONFIG });
}

/** Median of a small sample — robust to a single slow GC pause (non-flaky). */
function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

async function timeDetect(reads: DetectorReads, runs = 5): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await detect(reads);
    samples.push(performance.now() - start);
  }
  return median(samples);
}

describe("detector active-scoping is signal-preserving (FLOW-04 equivalence)", () => {
  it("scope = every NON-TERMINAL trailer status (the active predicate)", () => {
    // FLOW-04 fix: arrived/docked trailers still carry detectable freight
    // (over-carry past a drop hub is precisely an arrived/docked trailer with
    // stale cargo). All three live lifecycle statuses are ACTIVE; only a future
    // terminal/retired status is excluded by the predicate.
    expect([...ACTIVE_TRAILER_STATUSES]).toEqual(["in_transit", "arrived", "docked"]);
    expect(isActiveTrailerStatus("in_transit")).toBe(true);
    expect(isActiveTrailerStatus("arrived")).toBe(true);
    expect(isActiveTrailerStatus("docked")).toBe(true);
    // A status outside the live lifecycle (a future terminal/retired trailer) is
    // excluded for free — the predicate is the sole coupling point.
    expect(isActiveTrailerStatus("retired")).toBe(false);
  });

  it("scoped reads detect EXACTLY the same exceptions as an unscoped read over the active set", async () => {
    // Active set: one wrong-trailer (PKG-W observed on the wrong active
    // trailer) + one missed-unload (PKG-M still aboard an ARRIVED trailer after
    // over-carrying past its DFW drop hub — exactly the case the in_transit-only
    // scope wrongly suppressed). Plus terminal noise that must not change the
    // active-set result either way.
    const trailers: TrailerRow[] = [
      { trailerId: "TRL-ACT-1", status: "in_transit" },
      { trailerId: "TRL-ACT-2", status: "arrived" }, // active (signal-bearing)
      { trailerId: "TRL-DONE", status: "retired" }, // terminal — no signal
    ];
    const planned: PlannedAssignment[] = [
      plan("PKG-W", "TRL-ACT-1", "LAX"),
      plan("PKG-M", "TRL-ACT-2", "DFW"),
      plan("PKG-OLD", "TRL-DONE", "ATL"), // terminal assignment
    ];
    const observed: ZoneEstimate[] = [
      // Wrong-trailer: PKG-W (planned TRL-ACT-1) seen on a SYNTHETIC trailer with
      // NO active state row — the exact case the in_transit/trailer-status scope
      // wrongly dropped. It is still in play because PKG-W is on an active
      // trailer; scoping by the active PACKAGE set keeps the disagreement.
      obs("PKG-W", "TRL-NO-STATE", 0.9),
      obs("PKG-M", "TRL-ACT-2", 0.92), // still aboard the arrived trailer (over-carry)
      obs("PKG-OLD", "TRL-DONE", 0.95), // terminal observation — inactive
    ];
    const departedHubs = ["DFW"];

    const scoped = await detect(
      harness(trailers, planned, observed, departedHubs, true),
    );
    // Reference: the SAME active set, read WITHOUT scoping, but supplied only the
    // active-set rows (the inactive TRL-DONE rows removed). Identical results.
    const activeTrailers = trailers.filter((t) => isActiveTrailerStatus(t.status));
    const activeIds = new Set(activeTrailers.map((t) => t.trailerId));
    const refPlanned = planned.filter(
      (p) => p.plannedTrailerId !== null && activeIds.has(p.plannedTrailerId),
    );
    // Reference scope is by the ACTIVE PACKAGE set (packages on an active
    // trailer), NOT the observed trailerId — matching the production read.
    const refPackageIds = new Set(refPlanned.map((p) => p.packageId));
    const refObserved = observed.filter((o) => refPackageIds.has(o.packageId));
    const reference = await detect(
      harness(activeTrailers, refPlanned, refObserved, departedHubs, false),
    );

    const summarize = (evs: readonly DomainEvent[]): string[] =>
      evs
        .map((e) => `${e.type}:${JSON.stringify(e.payload)}`)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    expect(summarize(scoped)).toEqual(summarize(reference));
    // Sanity: the active set DID produce both kinds of exception (not vacuous).
    expect(scoped.map((e) => e.type).sort()).toEqual([
      "MissedUnloadDetected",
      "WrongTrailerDetected",
    ]);
    // The terminal PKG-OLD observation never produced an exception.
    expect(JSON.stringify(scoped)).not.toContain("PKG-OLD");
  });

  it("detection cost tracks the active set, not the inactive total (~1-5k bounded, ratio-based)", async () => {
    // Small active set with a deterministic detection signal.
    const ACTIVE = 50;
    const INACTIVE = 4900; // total ~4950 ≤ 5000 (GATE-HYGIENE — NOT 10k)
    const trailers: TrailerRow[] = [
      { trailerId: "TRL-ACTIVE", status: "in_transit" },
      { trailerId: "TRL-OTHER", status: "in_transit" },
      { trailerId: "TRL-TERMINAL", status: "retired" },
    ];
    const planned: PlannedAssignment[] = [];
    const observed: ZoneEstimate[] = [];
    // Active: each PKG planned on TRL-ACTIVE but observed on TRL-OTHER ⇒ a
    // wrong-trailer disagreement (a real, bounded signal over the active set).
    for (let i = 0; i < ACTIVE; i++) {
      const pkg = `PKG-A-${i}`;
      planned.push(plan(pkg, "TRL-ACTIVE", "LAX"));
      observed.push(obs(pkg, "TRL-OTHER", 0.9));
    }
    // Inactive bulk: terminal observations on a `retired` trailer — pure cost
    // when unscoped, zero cost (and zero signal) when scoped out.
    for (let i = 0; i < INACTIVE; i++) {
      const pkg = `PKG-T-${i}`;
      planned.push(plan(pkg, "TRL-TERMINAL", "ATL"));
      observed.push(obs(pkg, "TRL-TERMINAL", 0.95));
    }

    const activeOnlyTrailers = trailers.filter((t) => isActiveTrailerStatus(t.status));
    const activeOnlyPlanned = planned.filter((p) => p.plannedTrailerId !== "TRL-TERMINAL");
    const activeOnlyObserved = observed.filter((o) => o.trailerId !== "TRL-TERMINAL");

    // Baseline: detection over ONLY the active subset (the irreducible work).
    const baseline = await timeDetect(
      harness(activeOnlyTrailers, activeOnlyPlanned, activeOnlyObserved, [], false),
    );
    // Scoped over the FULL 4950-row state: the adapter filters the inactive bulk
    // out, so cost should be ~the baseline (tracks active, not total).
    const scoped = await timeDetect(harness(trailers, planned, observed, [], true));

    // Correctness check: scoped detection over the full state still finds exactly
    // the active wrong-trailer exceptions.
    const scopedEvents = await detect(harness(trailers, planned, observed, [], true));
    expect(scopedEvents).toHaveLength(ACTIVE);
    expect(scopedEvents.every((e) => e.type === "WrongTrailerDetected")).toBe(true);

    // Ratio-based, robust bound: scoped-over-5k stays within a generous constant
    // multiple of the active-only baseline (it would blow past this if it scanned
    // the inactive total). Floor both to avoid divide-by-tiny noise on fast runs.
    const ratio = (scoped + 1) / (baseline + 1);
    expect(ratio).toBeLessThan(4);
  });
});
