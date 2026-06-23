import { describe, expect, expectTypeOf, it } from "vitest";
import {
  DEFAULT_HOS_CONFIG,
  applyDrivingLeg,
  applySleeperBerthPeriod,
  hosClockSchema,
  isoToEpochMinutes,
  mayDriveNow,
  remainingLegalDriveMinutes,
  type DutySegment,
  type DrivingLegResult,
  type HosClock,
  type SleeperBerthResult,
} from "../src/index.js";

/**
 * Phase-10 HOS engine (HOS-02 / HOS-03): the pure, deterministic
 * forward-labeling engine that turns a driving leg of N minutes into the legal
 * sequence of duty segments + the advanced {@link HosClock}, plus the
 * `remainingLegalDriveMinutes` / `mayDriveNow` clock arithmetic and the
 * sleeper-berth 7/3 & 8/2 split provisions.
 *
 * The engine is the SINGLE source of truth consumed (DRY) by both the simulator
 * (Phase 11) and the optimizer (Phase 16). It is PURE: no RNG, no I/O, no
 * `Date.now()` — every instant is passed in as an ISO `occurredAt`, internally
 * reduced to integer epoch-minutes. Tests assert behaviour against hand-computed
 * FMCSA fixtures, with the keystone trap (the 14h window is elapsed wall-clock,
 * NOT a pausing counter) called out by an explicit non-pause test.
 */

// --- Fixtures ---------------------------------------------------------------

/** A driver fresh off a 10h reset at 2024-01-01T08:00Z (epoch minute 28381920). */
const FRESH_AT = "2024-01-01T08:00:00.000Z";
const freshClock = (): HosClock => ({
  driveTodayMin: 0,
  dutyWindowStartAt: FRESH_AT,
  sinceLastBreakMin: 0,
  weeklyOnDutyMin: 0,
  comeOnDutyAt: FRESH_AT,
  sleeperBerthLongMin: 0,
  sleeperBerthShortMin: 0,
});

/** Sum the minutes of all segments of a given kind. */
const minutesOf = (segments: readonly DutySegment[], kind: DutySegment["kind"]): number =>
  segments.filter((s) => s.kind === kind).reduce((acc, s) => acc + s.minutes, 0);

const driveMinutes = (segments: readonly DutySegment[]): number => minutesOf(segments, "drive");

// --- isoToEpochMinutes (pure time helper) -----------------------------------

describe("isoToEpochMinutes (pure ISO↔minute conversion)", () => {
  it("converts an ISO stamp to integer epoch-minutes (no wall-clock read)", () => {
    expect(isoToEpochMinutes("1970-01-01T00:00:00.000Z")).toBe(0);
    expect(isoToEpochMinutes("1970-01-01T00:01:00.000Z")).toBe(1);
    expect(isoToEpochMinutes("1970-01-01T01:00:00.000Z")).toBe(60);
  });

  it("rejects a non-ISO / unparseable stamp", () => {
    expect(() => isoToEpochMinutes("not-a-date")).toThrow();
  });
});

// --- HOS-03: remainingLegalDriveMinutes -------------------------------------

describe("remainingLegalDriveMinutes (HOS-03)", () => {
  it("a fresh driver is bound by the 8h-break clock (480) — break binds first", () => {
    const now = isoToEpochMinutes(FRESH_AT);
    // min(660-0, 840-0, 480-0) = 480 — a fresh driver may drive at most 8h
    // before a mandatory 30-min break, so the break clock is the binding limit.
    expect(remainingLegalDriveMinutes(freshClock(), DEFAULT_HOS_CONFIG, now)).toBe(480);
  });

  it("the 8h-break clock binds once 8h have been driven without a break", () => {
    const now = isoToEpochMinutes(FRESH_AT) + 480;
    const clock: HosClock = { ...freshClock(), driveTodayMin: 480, sinceLastBreakMin: 480 };
    // min(660-480, 840-480, 480-480) = min(180, 360, 0) = 0
    expect(remainingLegalDriveMinutes(clock, DEFAULT_HOS_CONFIG, now)).toBe(0);
  });

  it("the 14h ABSOLUTE deadline binds near the end of the window", () => {
    // 13h elapsed, only 8h driven, no break due → window is the binding limit.
    const now = isoToEpochMinutes(FRESH_AT) + 780; // 13h elapsed
    const clock: HosClock = { ...freshClock(), driveTodayMin: 300, sinceLastBreakMin: 0 };
    // min(660-300, 840-780, 480-0) = min(360, 60, 480) = 60
    expect(remainingLegalDriveMinutes(clock, DEFAULT_HOS_CONFIG, now)).toBe(60);
  });

  it("clamps to 0 (never negative) past the 14h deadline", () => {
    const now = isoToEpochMinutes(FRESH_AT) + 900; // 15h elapsed, past the 840 deadline
    expect(remainingLegalDriveMinutes(freshClock(), DEFAULT_HOS_CONFIG, now)).toBe(0);
  });
});

// --- HOS-03: mayDriveNow ----------------------------------------------------

describe("mayDriveNow (HOS-03 predicate)", () => {
  it("true iff remaining>0 AND weeklyOnDutyMin < weeklyCapMin", () => {
    const now = isoToEpochMinutes(FRESH_AT);
    expect(mayDriveNow(freshClock(), DEFAULT_HOS_CONFIG, now)).toBe(true);
  });

  it("false when the weekly 70h/8-day cap is reached even with hours left today", () => {
    const now = isoToEpochMinutes(FRESH_AT);
    const capped: HosClock = { ...freshClock(), weeklyOnDutyMin: 4200 };
    // remaining=480>0 (per-shift clocks fresh) but the weekly cap is reached, so
    // the predicate is false — the cap is the gate remaining-minutes excludes.
    expect(remainingLegalDriveMinutes(capped, DEFAULT_HOS_CONFIG, now)).toBe(480);
    expect(mayDriveNow(capped, DEFAULT_HOS_CONFIG, now)).toBe(false);
  });

  it("false when remaining is 0 (past the window) regardless of the weekly cap", () => {
    const now = isoToEpochMinutes(FRESH_AT) + 900;
    expect(mayDriveNow(freshClock(), DEFAULT_HOS_CONFIG, now)).toBe(false);
  });
});

// --- HOS-02: applyDrivingLeg — determinism (property) -----------------------

describe("applyDrivingLeg determinism (HOS-02 property)", () => {
  it("identical inputs yield identical output (deep-equal, repeated)", () => {
    const inputs: ReadonlyArray<{ clock: HosClock; leg: number; at: string }> = [
      { clock: freshClock(), leg: 60, at: FRESH_AT },
      { clock: freshClock(), leg: 660, at: FRESH_AT },
      { clock: freshClock(), leg: 900, at: FRESH_AT }, // forces breaks + rests
      {
        clock: { ...freshClock(), driveTodayMin: 600, sinceLastBreakMin: 470 },
        leg: 120,
        at: FRESH_AT,
      },
    ];
    for (const { clock, leg, at } of inputs) {
      const a = applyDrivingLeg(clock, DEFAULT_HOS_CONFIG, leg, at);
      const b = applyDrivingLeg(clock, DEFAULT_HOS_CONFIG, leg, at);
      expect(a).toEqual(b);
    }
  });

  it("does not mutate the input clock (returns a fresh clock)", () => {
    const clock = freshClock();
    const snapshot = JSON.parse(JSON.stringify(clock)) as HosClock;
    applyDrivingLeg(clock, DEFAULT_HOS_CONFIG, 900, FRESH_AT);
    expect(clock).toEqual(snapshot);
  });

  it("the returned clock validates against hosClockSchema", () => {
    const { clock } = applyDrivingLeg(freshClock(), DEFAULT_HOS_CONFIG, 900, FRESH_AT);
    expect(() => hosClockSchema.parse(clock)).not.toThrow();
  });
});

// --- HOS-02: applyDrivingLeg — short leg (no insert) -------------------------

describe("applyDrivingLeg — leg shorter than every limit", () => {
  it("a 60-min leg by a fresh driver is one pure drive segment", () => {
    const { segments, clock } = applyDrivingLeg(freshClock(), DEFAULT_HOS_CONFIG, 60, FRESH_AT);
    expect(segments).toEqual([{ kind: "drive", minutes: 60 }]);
    expect(clock.driveTodayMin).toBe(60);
    expect(clock.sinceLastBreakMin).toBe(60);
    expect(driveMinutes(segments)).toBe(60);
  });

  it("total drive minutes across segments always equals the requested leg", () => {
    for (const leg of [1, 59, 60, 479, 480, 660, 661, 900, 1200]) {
      const { segments } = applyDrivingLeg(freshClock(), DEFAULT_HOS_CONFIG, leg, FRESH_AT);
      expect(driveMinutes(segments)).toBe(leg);
    }
  });
});

// --- HOS-02: 30-min break insertion at the 8h boundary ----------------------

describe("applyDrivingLeg — 30-min break after 8h driving (395.3(a)(3)(ii))", () => {
  it("inserts a 30-min break exactly at the 480-min cumulative-drive boundary", () => {
    // Drive 540 min straight: must break after 480, then drive the remaining 60.
    const { segments, clock } = applyDrivingLeg(freshClock(), DEFAULT_HOS_CONFIG, 540, FRESH_AT);
    expect(segments).toEqual([
      { kind: "drive", minutes: 480 },
      { kind: "break", minutes: 30 },
      { kind: "drive", minutes: 60 },
    ]);
    // After the break, the 8h clock is reset to the post-break driving (60).
    expect(clock.sinceLastBreakMin).toBe(60);
    // The 11h clock counts ALL driving (480 + 60 = 540).
    expect(clock.driveTodayMin).toBe(540);
  });

  it("the break resets the 8h clock but NOT the 11h clock", () => {
    const { clock } = applyDrivingLeg(freshClock(), DEFAULT_HOS_CONFIG, 481, FRESH_AT);
    expect(clock.sinceLastBreakMin).toBe(1); // 1 min driven after the break
    expect(clock.driveTodayMin).toBe(481); // 11h clock keeps the full total
  });
});

// --- HOS-02: the 14h window is ELAPSED wall-clock — does NOT pause -----------

describe("applyDrivingLeg — the 14h window is elapsed wall-clock (KEYSTONE TRAP)", () => {
  it("a 30-min break does NOT extend the 14h window deadline", () => {
    // Drive 540 straight: a break is inserted at 480. The window deadline must
    // stay at comeOnDuty+840 — the break's 30 min are NOT added back.
    const { clock } = applyDrivingLeg(freshClock(), DEFAULT_HOS_CONFIG, 540, FRESH_AT);
    // The window start is unchanged by a break (only a 10h rest / sleeper resets it).
    expect(clock.dutyWindowStartAt).toBe(FRESH_AT);
    const deadline = isoToEpochMinutes(clock.dutyWindowStartAt) + DEFAULT_HOS_CONFIG.dutyWindowMin;
    expect(deadline).toBe(isoToEpochMinutes(FRESH_AT) + 840);
  });

  it("driving + a break consumes elapsed wall-clock so the window can bind before 11h", () => {
    // Start 13h40m into the window (820 min elapsed). Window leaves 20 min; the
    // driver has lots of 11h budget but the elapsed window forces a 10h rest.
    const startAt = "2024-01-01T08:00:00.000Z";
    const clock: HosClock = {
      ...freshClock(),
      driveTodayMin: 100,
      sinceLastBreakMin: 100,
      dutyWindowStartAt: startAt,
      comeOnDutyAt: startAt,
    };
    const now = isoToEpochMinutes(startAt) + 820; // 20 min of window left
    const nowIso = new Date(now * 60_000).toISOString();
    const { segments } = applyDrivingLeg(clock, DEFAULT_HOS_CONFIG, 60, nowIso);
    // First 20 min drive (window), then a 10h rest, then the remaining 40 min.
    expect(segments[0]).toEqual({ kind: "drive", minutes: 20 });
    expect(segments[1]).toEqual({ kind: "rest", minutes: 600 });
    expect(driveMinutes(segments)).toBe(60);
  });
});

// --- HOS-02: 10h off-duty rest at the 11h drive limit -----------------------

describe("applyDrivingLeg — 10h off-duty rest (395.3(a)(1) / 11h limit 395.3(a)(3)(i))", () => {
  it("inserts a 10h rest when the 11h drive limit (660) would be exceeded", () => {
    // A 720-min leg: drive 480, break 30, drive 180 (=660 total), rest 600, drive 60.
    const { segments } = applyDrivingLeg(freshClock(), DEFAULT_HOS_CONFIG, 720, FRESH_AT);
    expect(driveMinutes(segments)).toBe(720);
    // A 600-min off-duty rest appears.
    expect(minutesOf(segments, "rest")).toBe(600);
    // Drive before the rest is capped at the 11h limit (660).
    const restIdx = segments.findIndex((s) => s.kind === "rest");
    const beforeRest = segments.slice(0, restIdx);
    expect(driveMinutes(beforeRest)).toBe(660);
  });

  it("the 10h rest resets the 11h, 8h and 14h clocks", () => {
    const { clock } = applyDrivingLeg(freshClock(), DEFAULT_HOS_CONFIG, 720, FRESH_AT);
    // After the post-rest 60-min drive: 11h clock = 60, 8h clock = 60.
    expect(clock.driveTodayMin).toBe(60);
    expect(clock.sinceLastBreakMin).toBe(60);
    // The window start was moved forward (rest resets the 14h window).
    expect(clock.dutyWindowStartAt).not.toBe(FRESH_AT);
    expect(isoToEpochMinutes(clock.dutyWindowStartAt)).toBeGreaterThan(isoToEpochMinutes(FRESH_AT));
  });
});

// --- HOS-02: weekly 70h/8-day cap + 34h restart -----------------------------

describe("applyDrivingLeg — weekly 70h/8-day cap + 34h restart (395.3(b)/(c))", () => {
  it("a leg that would breach the 70h weekly cap inserts a 34h restart", () => {
    // 30 min from the cap; a 60-min leg drives 30, then the 34h restart, then 30.
    const clock: HosClock = { ...freshClock(), weeklyOnDutyMin: 4170 };
    const { segments, clock: out } = applyDrivingLeg(clock, DEFAULT_HOS_CONFIG, 60, FRESH_AT);
    expect(driveMinutes(segments)).toBe(60);
    expect(minutesOf(segments, "rest")).toBe(DEFAULT_HOS_CONFIG.restartMin); // 2040
    // The restart zeroes the weekly counter, then 30 min of post-restart driving accrue.
    expect(out.weeklyOnDutyMin).toBe(30);
  });

  it("weeklyOnDutyMin accrues driving minutes (on-duty) for a within-cap leg", () => {
    const { clock } = applyDrivingLeg(freshClock(), DEFAULT_HOS_CONFIG, 120, FRESH_AT);
    expect(clock.weeklyOnDutyMin).toBe(120);
  });
});

// --- HOS-02: sleeper-berth splits 7/3 and 8/2 (395.1(g)) --------------------

describe("applySleeperBerthPeriod — 7/3 and 8/2 splits (395.1(g))", () => {
  it("a 7h sleeper period alone does NOT yet reset (pairing incomplete)", () => {
    const at = FRESH_AT;
    const clock: HosClock = { ...freshClock(), driveTodayMin: 400, sinceLastBreakMin: 200 };
    const { clock: out, reset } = applySleeperBerthPeriod(
      clock,
      DEFAULT_HOS_CONFIG,
      DEFAULT_HOS_CONFIG.sleeperBerthLongMin, // 420 (7h)
      at,
    );
    expect(reset).toBe(false);
    // The long accumulator now holds the 7h period; the drive clocks are untouched.
    expect(out.sleeperBerthLongMin).toBe(420);
    expect(out.driveTodayMin).toBe(400);
  });

  it("7/3 split: a 7h berth + a 3h period completes the 10h reset", () => {
    const clock: HosClock = { ...freshClock(), driveTodayMin: 500, sinceLastBreakMin: 300 };
    // First the 7h berth period (no reset yet)...
    const first = applySleeperBerthPeriod(
      clock,
      DEFAULT_HOS_CONFIG,
      DEFAULT_HOS_CONFIG.sleeperBerthLongMin, // 420
      FRESH_AT,
    );
    expect(first.reset).toBe(false);
    // ...then a 3h period a few hours later → the pair satisfies the 10h reset.
    const secondAt = new Date((isoToEpochMinutes(FRESH_AT) + 420 + 200) * 60_000).toISOString();
    const second = applySleeperBerthPeriod(
      first.clock,
      DEFAULT_HOS_CONFIG,
      DEFAULT_HOS_CONFIG.sleeperBerthShortMin, // 180 (3h)
      secondAt,
    );
    expect(second.reset).toBe(true);
    // The 11h and 8h clocks are reset by the completed split.
    expect(second.clock.driveTodayMin).toBe(0);
    expect(second.clock.sinceLastBreakMin).toBe(0);
    // The split accumulators are cleared after a completed reset.
    expect(second.clock.sleeperBerthLongMin).toBe(0);
    expect(second.clock.sleeperBerthShortMin).toBe(0);
  });

  it("8/2 split: an 8h berth + a 2h period completes the 10h reset", () => {
    const clock: HosClock = { ...freshClock(), driveTodayMin: 500, sinceLastBreakMin: 300 };
    const first = applySleeperBerthPeriod(
      clock,
      DEFAULT_HOS_CONFIG,
      DEFAULT_HOS_CONFIG.sleeperBerthAltLongMin, // 480 (8h)
      FRESH_AT,
    );
    expect(first.reset).toBe(false);
    const secondAt = new Date((isoToEpochMinutes(FRESH_AT) + 480 + 100) * 60_000).toISOString();
    const second = applySleeperBerthPeriod(
      first.clock,
      DEFAULT_HOS_CONFIG,
      DEFAULT_HOS_CONFIG.sleeperBerthAltShortMin, // 120 (2h)
      secondAt,
    );
    expect(second.reset).toBe(true);
    expect(second.clock.driveTodayMin).toBe(0);
    expect(second.clock.sinceLastBreakMin).toBe(0);
  });

  it("the SECOND (qualifying-sleeper) period does NOT count against the 14h window", () => {
    // The keystone non-monotonicity: the paired sleeper period's elapsed time is
    // excluded from the 14h window — the window deadline is pushed out by exactly
    // the qualifying sleeper period that does NOT count.
    const clock: HosClock = {
      ...freshClock(),
      driveTodayMin: 500,
      sinceLastBreakMin: 300,
    };
    const first = applySleeperBerthPeriod(
      clock,
      DEFAULT_HOS_CONFIG,
      DEFAULT_HOS_CONFIG.sleeperBerthLongMin, // 420 (7h berth — the qualifying period)
      FRESH_AT,
    );
    // After the first (long) berth period, the window start advances by the
    // sleeper period that does not count (420 min) — proving non-monotonicity.
    expect(isoToEpochMinutes(first.clock.dutyWindowStartAt)).toBe(
      isoToEpochMinutes(FRESH_AT) + 420,
    );
  });

  it("is deterministic — identical inputs yield identical output", () => {
    const clock: HosClock = { ...freshClock(), driveTodayMin: 400 };
    const a = applySleeperBerthPeriod(clock, DEFAULT_HOS_CONFIG, 420, FRESH_AT);
    const b = applySleeperBerthPeriod(clock, DEFAULT_HOS_CONFIG, 420, FRESH_AT);
    expect(a).toEqual(b);
  });

  it("a too-short period (<2h) does NOT qualify as a split period", () => {
    const clock: HosClock = { ...freshClock(), driveTodayMin: 400 };
    const { clock: out, reset } = applySleeperBerthPeriod(clock, DEFAULT_HOS_CONFIG, 60, FRESH_AT);
    expect(reset).toBe(false);
    // A non-qualifying period leaves the long/short accumulators unchanged.
    expect(out.sleeperBerthLongMin).toBe(0);
    expect(out.sleeperBerthShortMin).toBe(0);
  });
});

// --- Types ------------------------------------------------------------------

describe("HOS engine exported types", () => {
  it("DutySegment is the closed {drive,break,rest,sleeper} kind + integer minutes", () => {
    expectTypeOf<DutySegment["kind"]>().toEqualTypeOf<
      "drive" | "break" | "rest" | "sleeper"
    >();
    expectTypeOf<DutySegment["minutes"]>().toEqualTypeOf<number>();
  });

  it("DrivingLegResult carries the segments + the advanced clock", () => {
    expectTypeOf<DrivingLegResult["segments"]>().toEqualTypeOf<readonly DutySegment[]>();
    expectTypeOf<DrivingLegResult["clock"]>().toEqualTypeOf<HosClock>();
  });

  it("SleeperBerthResult carries the advanced clock + a reset flag", () => {
    expectTypeOf<SleeperBerthResult["clock"]>().toEqualTypeOf<HosClock>();
    expectTypeOf<SleeperBerthResult["reset"]>().toEqualTypeOf<boolean>();
  });
});
