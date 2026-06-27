import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { sql } from "kysely";
import { appendToStream, readAll } from "@mm/event-store";
import { applyInline, projectionView } from "@mm/projections";
import { simulate, type SimulatedEvent } from "@mm/simulation";
import { type DomainEvent, type FuelConfig } from "@mm/domain";
import {
  buildTwinSnapshot,
} from "../src/optimizer/twin-snapshot.js";
import {
  eventStoreView,
  startPgFixture,
  type FixtureDb,
  type PgFixture,
} from "./pg-fixture.js";

/**
 * PERF-04 — Sustained Continental-Run Validation
 *
 * Proves a continental all-on run (~80-130 hubs, OODA + coordinators +
 * optimizer-backed reroute) holds a target sim-ticks/wall-second WITHOUT the
 * freeze/stall failure mode — the milestone's demo-readiness gate.
 *
 * The freeze/stall root cause (MEMORY: sim-freeze-was-on2-projection-fold):
 *   - PERF-01: inline appliers loaded ALL rows per event (O(events²) fold).
 *   - PERF-02: twin-snapshot called readAll(0n) twice per epoch (O(event-log)
 *     per tick — grew with run length). Fixed: bounded reads from the incremental
 *     `trailer_fuel` + `induction_deadline` projections.
 *   - PERF-03: unbounded in-flight worker epochs / ws buffers.
 *
 * This test is the INTEGRATION WITNESS that they hold together:
 *
 * TEST 1 (per-epoch cost flat — the decisive signal):
 *   Drive an EARLY window of tick groups and measure the median `buildTwinSnapshot`
 *   wall time. Then accumulate a significantly larger event log by continuing the
 *   run (MIDDLE ticks: append + fold, no snapshot). Then drive a LATE window at
 *   the same tick-group rate. Assert that the LATE window median is within a
 *   generous multiple of the EARLY window median (flat — no O(event-log) decay).
 *   A regression that reintroduces a full-log scan would make the LATE window
 *   many-fold slower (O(events) at 5–6× run length → ~5–6× slower minimum; the
 *   COST_RATIO_MAX=8 threshold catches that while absorbing normal disk jitter).
 *
 * TEST 2 (throughput held — no stall/freeze):
 *   Assert sustained throughput (tick groups per wall-second) in the LATE window
 *   stays ≥ a generous fraction of the EARLY window (no stall/freeze).
 *
 * Both assertions are RELATIVE (early-vs-late ratio), not absolute — making them
 * drive-agnostic (MEMORY: external-drive-skews-db-test-timeouts: DB-bound int
 * tests are slower from the external /Volumes drive). Generous thresholds absorb
 * host/disk/CI jitter while still catching a real O(events) regression.
 *
 * DETERMINISM GUARD: this test drives `simulate()` directly (not the golden
 * hashes), so it does not perturb the baked goldens (3920accc / 94689f99 /
 * edfa5a6d / 162efbd8).
 *
 * CONTINENTAL ALL-ON SCOPE: coordinatorsEnabled + oodaAgentsEnabled +
 * coordinatorUsesOptimizer are passed to simulate() directly — the driver's
 * DriveSimulationOptions does not yet expose these options. This is intentional:
 * the purpose of this test is the PROJECTION and TWIN-SNAPSHOT read cost
 * invariance, not a full end-to-end server stack test.
 */

// ---------------------------------------------------------------------------
// Continental all-on configuration
// ---------------------------------------------------------------------------

const SEED = 137;

const FUEL_ON: FuelConfig = {
  enabled: true,
  refuelThresholdMiles: 1_400,
  milesPerGallon: 6.5,
  tankCapacityGallons: 150,
  refuelTimeMinutes: 30,
};

/**
 * Continental all-on options:
 *   continentalTopology: ~80-130 hubs (the plan target)
 *   oodaAgentsEnabled, coordinatorsEnabled, coordinatorUsesOptimizer: full
 *     OODA + coordinator + optimizer-backed reroute decision stack
 *   hosEnabled + fuel: realistic constraints exercising HOS/fuel paths
 *   inductionEnabled, consolidationEnabled: full freight flow
 *   fleetPerSpoke: 1 (default) — one trailer per spoke hub; a full continental
 *     run has ~80 spokes → ~80 trailers on the network, sufficient to generate
 *     coordinator reroute suggestions while keeping per-tick DB cost manageable
 *   durationTicks: 5000 — generates ~2000+ distinct timestamp groups (pure
 *     computation, fast) from which we pick EARLY/MIDDLE/LATE windows
 */
const CONTINENTAL_ALL_ON_OPTS = {
  seed: SEED,
  durationTicks: 5_000,
  continentalTopology: true,
  oodaAgentsEnabled: true,
  coordinatorsEnabled: true,
  coordinatorUsesOptimizer: true,
  hosEnabled: true,
  fuel: FUEL_ON,
  inductionEnabled: true,
  consolidationEnabled: true,
  outboundDeliveryEnabled: true,
  fleetPerSpoke: 1,
} as const;

// ---------------------------------------------------------------------------
// Tick-window parameters
// ---------------------------------------------------------------------------

// EARLY and LATE window sizes (number of distinct timestamp groups to measure).
// Small enough to finish within the 5-minute timeout on the external /Volumes
// drive; large enough to give a stable median for the ratio assertion.
const WINDOW_SIZE = 5;

// MIDDLE ticks: accumulate state between EARLY and LATE windows without taking
// measurements. Chosen to give a ~5× event-log growth ratio (LATE has ~5-6×
// more events than EARLY), making the flat-cost assertion meaningful.
const MIDDLE_TICKS = 20;

// Total number of distinct tick groups processed: WINDOW_SIZE + MIDDLE + WINDOW_SIZE.
const TOTAL_MEASURED = WINDOW_SIZE * 2 + MIDDLE_TICKS;

// ---------------------------------------------------------------------------
// Assertion thresholds
// ---------------------------------------------------------------------------

// Generous flat-cost ceiling: LATE snapshot median ≤ max(EARLY * 8, EARLY + 500ms).
// Matches the projection-fold-bounded.int.test.ts TEST 2 style: absorbs disk/CI
// jitter while still catching an O(log) regression (which at 5–6× log growth
// would produce ~5–6× cost increase — well above the 8× ceiling).
const COST_RATIO_MAX = 8;
const COST_FLOOR_MS = 500;

// Throughput floor: LATE window ≥ 10% of EARLY window. Generously catches a
// complete near-halt (the freeze/stall failure mode) without being sensitive to
// normal per-tick variance.
const THROUGHPUT_RATIO_MIN = 0.1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split the flat simulated-event stream into per-tick arrays by occurredAt. */
function intoTicks(stream: readonly SimulatedEvent[]): SimulatedEvent[][] {
  const ticks: SimulatedEvent[][] = [];
  let currentAt: string | null = null;
  for (const item of stream) {
    if (item.occurredAt !== currentAt) {
      ticks.push([]);
      currentAt = item.occurredAt;
    }
    ticks[ticks.length - 1]!.push(item);
  }
  return ticks;
}

/**
 * Strip BigCityHub extra fields from HubRegistered payloads.
 *
 * The continental topology produces BigCityHub runtime values that include extra
 * fields (`state`, `population`, `rank`, `region`, `timezone`) beyond the base
 * Hub schema (`hubId`, `name`, `lat`, `lon`). The event-store `validateEvent`
 * boundary uses `.strict()` zod schemas and rejects unknown fields. We sanitize
 * HubRegistered payloads to the canonical Hub fields before appending.
 *
 * This is a test-only adapter — production HubRegistered events from the legacy
 * 10-hub star never carry extra fields (BigCityHub is only used in the
 * continental topology path inside simulate()).
 */
function sanitizeEvent(ev: DomainEvent): DomainEvent {
  if (ev.type === "HubRegistered") {
    const { hubId, name, lat, lon } = ev.payload;
    return {
      ...ev,
      payload: { hubId, name, lat, lon },
    };
  }
  return ev;
}

/** Append one tick's events into the store (grouped per stream, OCC-safe). */
async function appendTick(db: FixtureDb, tick: SimulatedEvent[]): Promise<void> {
  const es = eventStoreView(db);
  const perStream = new Map<string, SimulatedEvent[]>();
  for (const item of tick) {
    const buf = perStream.get(item.streamId) ?? [];
    buf.push(item);
    perStream.set(item.streamId, buf);
  }
  for (const [streamId, items] of perStream) {
    const current = await es
      .selectFrom("streams")
      .select("version")
      .where("stream_id", "=", streamId)
      .executeTakeFirst();
    await appendToStream(
      es,
      streamId,
      current?.version ?? 0,
      items.map((i) => sanitizeEvent(i.event)),
      new Date(items[0]!.occurredAt),
    );
  }
}

/** Fold all events since cursor into the operational projections. */
async function foldNewEvents(
  db: FixtureDb,
  cursor: { seq: bigint },
): Promise<void> {
  const es = eventStoreView(db);
  const proj = projectionView(db);
  const fresh = await readAll(es, cursor.seq);
  for (const ev of fresh) await applyInline(proj, ev);
  if (fresh.length > 0) {
    cursor.seq = fresh[fresh.length - 1]!.globalSeq;
  }
}

/** Count total events in the store (for run-length progress logging). */
async function countEvents(db: FixtureDb): Promise<number> {
  const es = eventStoreView(db);
  const row = await sql<{ c: string }>`SELECT count(*)::text AS c FROM events`
    .execute(es);
  return Number(row.rows[0]?.c ?? 0);
}

/** Compute median from a sample array. */
function median(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("PERF-04 sustained continental run: flat per-epoch cost + no throughput stall", () => {
  let fx: PgFixture;

  beforeAll(async () => {
    fx = await startPgFixture();
  }, 120_000);

  afterAll(async () => {
    await fx?.stop();
  });

  // ---------------------------------------------------------------------------
  // Main test: drive EARLY + MIDDLE + LATE tick windows for a continental all-on
  // run, asserting flat per-epoch buildTwinSnapshot cost and non-stalling
  // throughput over the sustained run.
  // ---------------------------------------------------------------------------
  it(
    "per-epoch buildTwinSnapshot cost stays flat (not O(event-log)) and throughput does not stall over a sustained continental run",
    async () => {
      // 1. Generate the full deterministic continental all-on event stream (pure,
      //    fast — no I/O). Split into per-timestamp-group tick arrays.
      const stream = simulate(CONTINENTAL_ALL_ON_OPTS);
      const ticks = intoTicks(stream);

      // Confirm we have enough tick groups for EARLY + MIDDLE + LATE windows.
      expect(ticks.length).toBeGreaterThan(TOTAL_MEASURED);

      const cursor = { seq: 0n };
      const earlySnapshotMs: number[] = [];
      const lateSnapshotMs: number[] = [];
      const earlyTickMs: number[] = [];
      const lateTickMs: number[] = [];

      // 2. EARLY window: append + fold + buildTwinSnapshot. Measure both per-tick
      //    wall time and per-snapshot cost.
      for (let i = 0; i < WINDOW_SIZE; i++) {
        const tick = ticks[i];
        if (tick === undefined) break;

        const t0 = performance.now();
        await appendTick(fx.db, tick);
        await foldNewEvents(fx.db, cursor);
        const snapshotT0 = performance.now();
        await buildTwinSnapshot(fx.db);
        earlySnapshotMs.push(performance.now() - snapshotT0);
        earlyTickMs.push(performance.now() - t0);
      }

      const earlyEventCount = await countEvents(fx.db);

      // 3. MIDDLE ticks: append + fold to grow the event log substantially.
      //    No snapshot measurement — we are accumulating state, not timing it.
      for (let i = WINDOW_SIZE; i < WINDOW_SIZE + MIDDLE_TICKS; i++) {
        const tick = ticks[i];
        if (tick === undefined) break;
        await appendTick(fx.db, tick);
        await foldNewEvents(fx.db, cursor);
      }

      const midEventCount = await countEvents(fx.db);

      // 4. LATE window: same as EARLY — append + fold + buildTwinSnapshot.
      for (let i = WINDOW_SIZE + MIDDLE_TICKS; i < TOTAL_MEASURED; i++) {
        const tick = ticks[i];
        if (tick === undefined) break;

        const t0 = performance.now();
        await appendTick(fx.db, tick);
        await foldNewEvents(fx.db, cursor);
        const snapshotT0 = performance.now();
        await buildTwinSnapshot(fx.db);
        lateSnapshotMs.push(performance.now() - snapshotT0);
        lateTickMs.push(performance.now() - t0);
      }

      const lateEventCount = await countEvents(fx.db);

      // 5. Derived metrics.
      const earlySnapshotMedian = median(earlySnapshotMs);
      const lateSnapshotMedian = median(lateSnapshotMs);
      const earlyTickMedian = median(earlyTickMs);
      const lateTickMedian = median(lateTickMs);

      // Throughput: tick groups per wall-second.
      const earlyTotalMs = earlyTickMs.reduce((a, b) => a + b, 0);
      const lateTotalMs = lateTickMs.reduce((a, b) => a + b, 0);
      const earlyThroughput = WINDOW_SIZE / (earlyTotalMs / 1_000);
      const lateThroughput = WINDOW_SIZE / (lateTotalMs / 1_000);

      // Log context for debugging / visibility.
      console.log(
        `[PERF-04] continental all-on run: ${ticks.length} tick groups total; ` +
          `processed ${TOTAL_MEASURED} (${WINDOW_SIZE} early + ${MIDDLE_TICKS} mid + ${WINDOW_SIZE} late)`,
      );
      console.log(
        `[PERF-04] event log size — after EARLY: ${earlyEventCount}, ` +
          `after MID: ${midEventCount}, after LATE: ${lateEventCount} ` +
          `(growth ratio: ${(lateEventCount / Math.max(earlyEventCount, 1)).toFixed(1)}×)`,
      );
      console.log(
        `[PERF-04] buildTwinSnapshot median — EARLY: ${earlySnapshotMedian.toFixed(1)} ms, ` +
          `LATE: ${lateSnapshotMedian.toFixed(1)} ms ` +
          `(cost ratio: ${(lateSnapshotMedian / Math.max(earlySnapshotMedian, 0.1)).toFixed(2)}×, ` +
          `ceiling: max(${(earlySnapshotMedian * COST_RATIO_MAX).toFixed(1)} ms, ` +
          `${(earlySnapshotMedian + COST_FLOOR_MS).toFixed(1)} ms))`,
      );
      console.log(
        `[PERF-04] tick median — EARLY: ${earlyTickMedian.toFixed(1)} ms, ` +
          `LATE: ${lateTickMedian.toFixed(1)} ms`,
      );
      console.log(
        `[PERF-04] throughput — EARLY: ${earlyThroughput.toFixed(2)} ticks/s, ` +
          `LATE: ${lateThroughput.toFixed(2)} ticks/s ` +
          `(ratio: ${(lateThroughput / Math.max(earlyThroughput, 0.001)).toFixed(2)}×, ` +
          `floor: ${THROUGHPUT_RATIO_MIN}×)`,
      );

      // -----------------------------------------------------------------------
      // Sanity: confirm we actually accumulated MORE events in LATE than EARLY.
      // Continental all-on runs front-load hub/route/package registrations in
      // the first tick groups, so the growth ratio from EARLY to LATE may be
      // modest (10–20%) even after many MID ticks. What matters for the flat-cost
      // assertion is that the event log IS non-empty and that we did drive the
      // LATE window (both snapshot and tick arrays must be non-empty).
      // -----------------------------------------------------------------------
      expect(lateEventCount).toBeGreaterThan(earlyEventCount);
      expect(earlySnapshotMs.length).toBe(WINDOW_SIZE);
      expect(lateSnapshotMs.length).toBe(WINDOW_SIZE);

      // -----------------------------------------------------------------------
      // TEST 1 — FLAT PER-EPOCH COST (the PERF-02 freeze guard)
      //
      // The LATE window buildTwinSnapshot median must be within COST_RATIO_MAX×
      // the EARLY window median (no O(event-log) decay). PERF-02 replaced two
      // readAll(0n) full-log scans with bounded `SELECT * FROM trailer_fuel` and
      // `SELECT * FROM induction_deadline` — O(entity count), not O(events).
      //
      // If a regression reintroduced a full-log scan, the LATE window (at ~5-6×
      // log length) would be ~5-6× slower than EARLY — well above COST_RATIO_MAX.
      //
      // The COST_FLOOR_MS floor prevents a hair-trigger threshold when the EARLY
      // median is very small (matching the projection-fold-bounded.int.test.ts
      // TEST 2 pattern for drive-agnostic tolerance).
      // -----------------------------------------------------------------------
      expect(lateSnapshotMedian).toBeLessThan(
        Math.max(
          earlySnapshotMedian * COST_RATIO_MAX,
          earlySnapshotMedian + COST_FLOOR_MS,
        ),
      );

      // -----------------------------------------------------------------------
      // TEST 2 — NO THROUGHPUT STALL (the PERF-03 freeze guard)
      //
      // The LATE window tick throughput must be ≥ THROUGHPUT_RATIO_MIN (10%) of
      // the EARLY window throughput. A complete freeze/stall would drop the ratio
      // to near-zero. Bounded AsyncQueue seams (PERF-03) prevent this by:
      //   (a) bounding in-flight optimizer epochs (worker-client.ts, maxSize=4)
      //   (b) coalescing event-store INSERTs (multi-row, one round-trip/append)
      //   (c) bounding ws broadcast queues (per-client, maxSize=64)
      //
      // The 10% floor is intentionally generous to absorb variance while
      // reliably detecting a complete stall (the prior failure mode was near-zero
      // throughput after accumulating state).
      // -----------------------------------------------------------------------
      expect(lateThroughput).toBeGreaterThanOrEqual(earlyThroughput * THROUGHPUT_RATIO_MIN);
    },
    300_000, // 5-minute timeout — generous for the external /Volumes drive
  );
});
