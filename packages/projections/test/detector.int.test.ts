import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@mm/domain";
import {
  DEFAULT_DETECTION_CONFIG,
  type PlannedAssignment,
  type ZoneEstimate,
} from "@mm/sensor-fusion";
import {
  emptyExceptionsState,
  exceptionsReducer,
  type ExceptionsState,
  falsePositiveRate,
  type DetectorReads,
  type OccurredEvent,
  openExceptions,
  runDetection,
} from "../src/index.js";

/**
 * Plan 03-06 (SNS-04/05) — END-TO-END detector integration over the composed
 * pure pieces: the PLANNED layer (trailer-state assignment + dest hub) and the
 * OBSERVED layer (zone estimates) feed `runDetection`, whose ONLY side effect is
 * appending exception events; those fold through the real `exceptionsReducer`
 * into the open-exceptions feed + false-positive KPI.
 *
 * This suite drives the detector through the SAME read ports + reducer the
 * inline applier uses (no Postgres needed here — the real-Postgres + seeded-sim
 * end-to-end lives in `@mm/api`, keeping the workspace DAG acyclic). It proves
 * the four contract points:
 *   (a) a deliberate wrong-trailer ⇒ exactly one WrongTrailerDetected (+severity,
 *       +recommendedAction);
 *   (b) a missed-unload (package for a DEPARTED hub still observed) ⇒ one
 *       MissedUnloadDetected, gated POST-departure;
 *   (c) anti-P6: packages with NO reads ⇒ ZERO exceptions, never "missing";
 *   (d) the feed does not flood — re-running is idempotent + the FP-rate KPI is
 *       a real, low number on a credible run.
 */

const T0 = Date.parse("2026-05-01T00:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

/** Build a zone estimate (the OBSERVED layer entry). */
function obs(
  packageId: string,
  trailerId: string,
  confidence: number,
): ZoneEstimate {
  return {
    packageId,
    trailerId,
    estimatedZone: "middle",
    confidence,
    posterior: { rear: 0.2, middle: confidence, nose: 0.8 - confidence },
    lastReliableCheckpoint: null,
    lastObservedAt: at(0),
  };
}

function planned(
  packageId: string,
  plannedTrailerId: string | null,
  destHubId: string,
): PlannedAssignment {
  return { packageId, plannedTrailerId, destHubId };
}

/**
 * An in-memory append sink + a `DetectorReads` port backed by fixed snapshots.
 * The append round-trips each event back through `exceptionsReducer` so the test
 * observes EXACTLY what the inline applier would persist (read-your-writes).
 */
function harness(snapshot: {
  planned: readonly PlannedAssignment[];
  observed: readonly ZoneEstimate[];
  departedHubs: readonly string[];
}): {
  reads: DetectorReads;
  appended: DomainEvent[];
  state: () => ExceptionsState;
} {
  const appended: DomainEvent[] = [];
  let folded: ExceptionsState = emptyExceptionsState;
  const existing = new Set<string>();
  let clock = 0;

  const reads: DetectorReads = {
    readPlannedAssignments: () => Promise.resolve(snapshot.planned),
    readObserved: () => Promise.resolve(snapshot.observed),
    readDepartedHubs: () => Promise.resolve(snapshot.departedHubs),
    readExistingExceptionIds: () => Promise.resolve(new Set(existing)),
    append: (_streamId, build) => {
      const events = build(0);
      for (const event of events) {
        appended.push(event);
        const occurredAt = at(clock++);
        const occ: OccurredEvent = { event, occurredAt };
        folded = exceptionsReducer(folded, occ);
      }
      // Mirror the inline projection so a second run dedupes (no flood).
      for (const ex of folded.open.values()) existing.add(ex.exceptionId);
      return Promise.resolve();
    },
  };

  return { reads, appended, state: () => folded };
}

describe("runDetection — end-to-end (SNS-04/05)", () => {
  it("(a) a deliberate wrong-trailer yields exactly one WrongTrailerDetected with severity + action", async () => {
    const h = harness({
      planned: [planned("PKG-1", "TRL-A", "LAX")],
      observed: [obs("PKG-1", "TRL-B", 0.82)], // observed in the WRONG trailer
      departedHubs: [],
    });

    await runDetection(h.reads, { config: DEFAULT_DETECTION_CONFIG });

    const open = openExceptions(h.state());
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      kind: "wrong-trailer",
      packageId: "PKG-1",
      trailerId: "TRL-B",
    });
    expect(open[0]?.severity).toBeTruthy();
    expect(open[0]?.recommendedAction).toBeTruthy();
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]?.type).toBe("WrongTrailerDetected");
  });

  it("(b) a missed-unload (departed hub still observed) yields one MissedUnloadDetected, post-departure gated", async () => {
    // The package destined for DFW is STILL observed aboard after DFW departure.
    const h = harness({
      planned: [planned("PKG-2", "TRL-X", "DFW")],
      observed: [obs("PKG-2", "TRL-X", 0.9)],
      departedHubs: ["DFW"],
    });

    await runDetection(h.reads, { config: DEFAULT_DETECTION_CONFIG });

    const open = openExceptions(h.state());
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: "missed-unload", packageId: "PKG-2", hubId: "DFW" });
    expect(h.appended[0]?.type).toBe("MissedUnloadDetected");
  });

  it("(b') missed-unload does NOT fire before departure (gating)", async () => {
    const h = harness({
      planned: [planned("PKG-2", "TRL-X", "DFW")],
      observed: [obs("PKG-2", "TRL-X", 0.9)],
      departedHubs: [], // DFW has NOT departed yet
    });
    await runDetection(h.reads, { config: DEFAULT_DETECTION_CONFIG });
    expect(openExceptions(h.state())).toHaveLength(0);
  });

  it("(c) anti-P6: packages with NO observations produce ZERO exceptions (never 'missing')", async () => {
    // A full plan, a departed hub — but the OBSERVED layer is EMPTY (lossy run).
    const h = harness({
      planned: [
        planned("PKG-A", "TRL-A", "LAX"),
        planned("PKG-B", "TRL-A", "DFW"),
        planned("PKG-C", "TRL-B", "DFW"),
      ],
      observed: [], // absence of reads
      departedHubs: ["DFW", "LAX"],
    });

    await runDetection(h.reads, { config: DEFAULT_DETECTION_CONFIG });

    expect(h.appended).toHaveLength(0);
    expect(openExceptions(h.state())).toHaveLength(0);
    expect(falsePositiveRate(h.state())).toBe(0);
  });

  it("(c') partial loss: only the OBSERVED-and-disagreeing package fires; the absent one never does", async () => {
    const h = harness({
      planned: [
        planned("PKG-SEEN", "TRL-A", "LAX"),
        planned("PKG-ABSENT", "TRL-A", "LAX"),
      ],
      observed: [obs("PKG-SEEN", "TRL-B", 0.85)], // only PKG-SEEN is read
      departedHubs: [],
    });
    await runDetection(h.reads, { config: DEFAULT_DETECTION_CONFIG });
    const open = openExceptions(h.state());
    expect(open).toHaveLength(1);
    expect(open[0]?.packageId).toBe("PKG-SEEN");
  });

  it("(d) the feed does not flood: re-running detection is idempotent (no duplicates)", async () => {
    const h = harness({
      planned: [planned("PKG-1", "TRL-A", "LAX")],
      observed: [obs("PKG-1", "TRL-B", 0.82)],
      departedHubs: [],
    });

    await runDetection(h.reads, { config: DEFAULT_DETECTION_CONFIG });
    await runDetection(h.reads, { config: DEFAULT_DETECTION_CONFIG });
    await runDetection(h.reads, { config: DEFAULT_DETECTION_CONFIG });

    expect(openExceptions(h.state())).toHaveLength(1);
    expect(h.appended).toHaveLength(1); // dedupe stops the re-append
  });

  it("(d') a normal noisy run keeps the FP-rate low (credible feed, mostly above the band)", async () => {
    // 4 wrong-trailer disagreements: 3 high-confidence (credible) + 1 marginal.
    const h = harness({
      planned: [
        planned("PKG-1", "TRL-A", "LAX"),
        planned("PKG-2", "TRL-A", "LAX"),
        planned("PKG-3", "TRL-A", "LAX"),
        planned("PKG-4", "TRL-A", "LAX"),
      ],
      observed: [
        obs("PKG-1", "TRL-B", 0.95),
        obs("PKG-2", "TRL-B", 0.88),
        obs("PKG-3", "TRL-B", 0.81),
        obs("PKG-4", "TRL-B", 0.63), // marginal (below the 0.7 band)
      ],
      departedHubs: [],
    });

    await runDetection(h.reads, { config: DEFAULT_DETECTION_CONFIG });

    expect(openExceptions(h.state())).toHaveLength(4);
    expect(falsePositiveRate(h.state())).toBeCloseTo(0.25, 10); // 1/4 marginal
    expect(falsePositiveRate(h.state())).toBeLessThan(0.5);
  });
});
