/**
 * KpiDashboard tests (TDD RED → GREEN).
 *
 * Tests the pure KPI state-management logic extracted from KpiDashboard:
 *  - `applyKpiPartial`: merges a Partial<KpiSnapshot> onto the current snapshot
 *  - `formatKpiValue`: formats a KPI value (count vs percentage vs fraction)
 *  - `shouldAnimate`: determines if a field changed (to trigger animation)
 *  - `kpiCards`: returns the ordered card definitions for rendering
 *
 * The business logic is in pure functions — no DOM/React required.
 * The component itself is a thin shell over these helpers.
 */
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../test/msw/server.js";
import {
  KpiDashboard,
  applyKpiPartial,
  formatKpiValue,
  shouldAnimate,
  kpiCards,
  shouldRefetchKpis,
  type KpiState,
  type KpiCardDef,
} from "./KpiDashboard.js";
import { WsProvider } from "../map/WsProvider.js";
import type { KpiSnapshot, WsEnvelope } from "@mm/api";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMPTY_BASELINE: Omit<KpiSnapshot, "baseline"> = {
  utilization: 0,
  rehandleCount: 0,
  rehandleMinutes: 0,
  wrongTrailerCount: 0,
  missedUnloadCount: 0,
  slaViolationRate: 0,
  onTimeDeparture: 1,
  onTimeArrival: 1,
};

function makeSnapshot(overrides: Partial<Omit<KpiSnapshot, "baseline">> = {}): KpiSnapshot {
  return {
    utilization: overrides.utilization ?? 0.75,
    rehandleCount: overrides.rehandleCount ?? 3,
    rehandleMinutes: overrides.rehandleMinutes ?? 18.5,
    wrongTrailerCount: overrides.wrongTrailerCount ?? 1,
    missedUnloadCount: overrides.missedUnloadCount ?? 0,
    slaViolationRate: overrides.slaViolationRate ?? 0.05,
    onTimeDeparture: overrides.onTimeDeparture ?? 0.94,
    onTimeArrival: overrides.onTimeArrival ?? 0.91,
    baseline: EMPTY_BASELINE,
  };
}

function makeState(snap: KpiSnapshot): KpiState {
  return { current: snap, animatingFields: new Set() };
}

// ---------------------------------------------------------------------------
// applyKpiPartial
// ---------------------------------------------------------------------------

describe("applyKpiPartial", () => {
  it("merges only changed fields onto the current snapshot", () => {
    const prev = makeSnapshot();
    const partial: Partial<KpiSnapshot> = { rehandleCount: 5, slaViolationRate: 0.1 };
    const next = applyKpiPartial(prev, partial);

    expect(next.rehandleCount).toBe(5);
    expect(next.slaViolationRate).toBeCloseTo(0.1);
    // unchanged fields preserved
    expect(next.utilization).toBe(prev.utilization);
    expect(next.wrongTrailerCount).toBe(prev.wrongTrailerCount);
    expect(next.baseline).toBe(prev.baseline);
  });

  it("returns a new object (immutable update)", () => {
    const prev = makeSnapshot();
    const next = applyKpiPartial(prev, { rehandleCount: 10 });
    expect(next).not.toBe(prev);
  });

  it("applies an empty partial without changes", () => {
    const prev = makeSnapshot();
    const next = applyKpiPartial(prev, {});
    expect(next).toStrictEqual(prev);
  });

  it("handles partial with all fields updated", () => {
    const prev = makeSnapshot();
    const full: Partial<KpiSnapshot> = {
      utilization: 0.9,
      rehandleCount: 0,
      rehandleMinutes: 0,
      wrongTrailerCount: 0,
      missedUnloadCount: 0,
      slaViolationRate: 0,
      onTimeDeparture: 1,
      onTimeArrival: 1,
    };
    const next = applyKpiPartial(prev, full);
    expect(next.utilization).toBeCloseTo(0.9);
    expect(next.rehandleCount).toBe(0);
    expect(next.slaViolationRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F-02 — ws ticks must NOT clobber the REST-fetched KPIs; they trigger a refetch
// ---------------------------------------------------------------------------

describe("F-02: ws envelope drives a REST refetch, never overwrites live KPIs", () => {
  const liveKpis: KpiSnapshot = makeSnapshot({
    utilization: 0.82,
    rehandleCount: 4,
    slaViolationRate: 0.03,
  });

  it("applyKpiPartial with a zeroed partial would clobber — so the merge path must not be used for ws", () => {
    // Documents the root cause: 0 ?? prev = 0, so a zeroed ws payload overwrites
    // the live REST values. This is WHY ws no longer feeds applyKpiPartial.
    const zeroPartial: Partial<KpiSnapshot> = {
      utilization: 0,
      rehandleCount: 0,
      slaViolationRate: 0,
    };
    const clobbered = applyKpiPartial(liveKpis, zeroPartial);
    expect(clobbered.utilization).toBe(0); // demonstrates the clobber
    expect(clobbered.rehandleCount).toBe(0);
  });

  it("a ws tick envelope is a refetch signal (sim advanced)", () => {
    const tick: WsEnvelope = {
      v: 1,
      type: "tick",
      seq: 7,
      simMs: 1000,
      speed: { multiplier: 1, tickIntervalMs: 500, simSpeed: 120, paused: false },
      payload: {},
    };
    expect(shouldRefetchKpis(tick)).toBe(true);
  });

  it("a ws snapshot envelope is also a refetch signal (initial/resync)", () => {
    const snap: WsEnvelope = {
      v: 1,
      type: "snapshot",
      seq: 1,
      simMs: 0,
      speed: { multiplier: 1, tickIntervalMs: 500, simSpeed: 120, paused: false },
      payload: { trailers: [], hubs: [], routes: [], exceptionsOpen: [] },
    };
    expect(shouldRefetchKpis(snap)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldAnimate
// ---------------------------------------------------------------------------

describe("shouldAnimate", () => {
  it("returns true when a numeric field value changes", () => {
    const prev = makeSnapshot({ rehandleCount: 2 });
    const next = makeSnapshot({ rehandleCount: 5 });
    expect(shouldAnimate("rehandleCount", prev, next)).toBe(true);
  });

  it("returns false when a field is unchanged", () => {
    const snap = makeSnapshot();
    expect(shouldAnimate("utilization", snap, snap)).toBe(false);
  });

  it("returns true for rate fields that change", () => {
    const prev = makeSnapshot({ slaViolationRate: 0.05 });
    const next = makeSnapshot({ slaViolationRate: 0.08 });
    expect(shouldAnimate("slaViolationRate", prev, next)).toBe(true);
  });

  it("returns false for the baseline field (it never updates live)", () => {
    // baseline is not a per-tick animatable field
    const snap = makeSnapshot();
    expect(shouldAnimate("baseline", snap, snap)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatKpiValue
// ---------------------------------------------------------------------------

describe("formatKpiValue", () => {
  it("formats integer count fields as whole numbers", () => {
    expect(formatKpiValue("rehandleCount", 7)).toBe("7");
    expect(formatKpiValue("wrongTrailerCount", 0)).toBe("0");
    expect(formatKpiValue("missedUnloadCount", 12)).toBe("12");
  });

  it("formats rehandleMinutes as a decimal with 1dp", () => {
    expect(formatKpiValue("rehandleMinutes", 18.5)).toBe("18.5 min");
    expect(formatKpiValue("rehandleMinutes", 0)).toBe("0.0 min");
    expect(formatKpiValue("rehandleMinutes", 72.5)).toBe("72.5 min");
  });

  it("formats rate / fraction fields as percentages with 1dp", () => {
    expect(formatKpiValue("utilization", 0.75)).toBe("75.0%");
    expect(formatKpiValue("slaViolationRate", 0.05)).toBe("5.0%");
    expect(formatKpiValue("onTimeDeparture", 0.94)).toBe("94.0%");
    expect(formatKpiValue("onTimeArrival", 0.91)).toBe("91.0%");
  });

  it("formats utilization 0 as 0%", () => {
    expect(formatKpiValue("utilization", 0)).toBe("0.0%");
  });

  it("formats 100% correctly", () => {
    expect(formatKpiValue("onTimeDeparture", 1.0)).toBe("100.0%");
  });
});

// ---------------------------------------------------------------------------
// kpiCards
// ---------------------------------------------------------------------------

describe("kpiCards", () => {
  it("returns exactly 8 card definitions", () => {
    const cards: readonly KpiCardDef[] = kpiCards();
    expect(cards).toHaveLength(8);
  });

  it("covers all 8 operational KPI fields", () => {
    const cards = kpiCards();
    const fields = cards.map((c) => c.field);
    expect(fields).toContain("utilization");
    expect(fields).toContain("rehandleCount");
    expect(fields).toContain("rehandleMinutes");
    expect(fields).toContain("wrongTrailerCount");
    expect(fields).toContain("missedUnloadCount");
    expect(fields).toContain("slaViolationRate");
    expect(fields).toContain("onTimeDeparture");
    expect(fields).toContain("onTimeArrival");
  });

  it("every card has a non-empty label", () => {
    const cards = kpiCards();
    for (const card of cards) {
      expect(card.label.length).toBeGreaterThan(0);
    }
  });

  it("every card has a non-empty field key from KpiSnapshot", () => {
    const cards = kpiCards();
    for (const card of cards) {
      expect(typeof card.field).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// KpiState shape
// ---------------------------------------------------------------------------

describe("KpiState", () => {
  it("applyKpiPartial produces a state where animatingFields contains changed keys", () => {
    // This tests the integration of state tracking:
    // fields that changed should be in animatingFields
    const prev = makeSnapshot({ rehandleCount: 2 });
    const next = applyKpiPartial(prev, { rehandleCount: 7 });
    // `Object.keys(next)` includes EVERY KpiSnapshot key — including the
    // non-numeric `baseline` sub-object — so the key array must be typed as the
    // FULL `keyof KpiSnapshot`. The previous `Omit<…,"baseline">` cast claimed
    // `baseline` was absent, which made the `k !== "baseline"` runtime guard a
    // type-impossible (no-overlap) comparison and let `baseline` slip past the
    // filter at runtime. Typing it correctly keeps the guard meaningful.
    const animatingFields = new Set(
      (Object.keys(next) as (keyof KpiSnapshot)[]).filter(
        (k) => k !== "baseline" && shouldAnimate(k, prev, next),
      ),
    );
    expect(animatingFields.has("rehandleCount")).toBe(true);
    expect(animatingFields.has("utilization")).toBe(false);
  });

  it("KpiState type holds current + animatingFields", () => {
    const state: KpiState = makeState(makeSnapshot());
    expect(state.current).toBeDefined();
    expect(state.animatingFields).toBeDefined();
    expect(state.animatingFields instanceof Set).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// <KpiDashboard /> — jsdom render (ui lane)
//
// Renders the real component against the MSW `/api/kpis` boundary. Covers:
//  - the zero / loading state before the initial fetch resolves ("—")
//  - the populated 8-card grid after `GET /api/kpis` (formatted values)
//  - the honest null branches (onTimeDeparture / onTimeArrival null → "—")
//  - a fetch-error path that leaves the honest zero state in place
//  - the ws-driven refetch + animation flash class (mergeLiveKpis path) under
//    a real WsProvider whose MSW ws channel auto-sends snapshot+tick on connect
//
// All overrides are per-test via `server.use(...)` so the shared handler file is
// never edited (the jsdom setup resets handlers between tests).
// ---------------------------------------------------------------------------

/** The KPI snapshot the default shared handler returns (handlers.ts `KPIS`). */
const DEFAULT_KPIS: KpiSnapshot = {
  utilization: 0.82,
  rehandleCount: 7,
  rehandleMinutes: 35,
  wrongTrailerCount: 2,
  missedUnloadCount: 1,
  slaViolationRate: 0.04,
  onTimeDeparture: 0.93,
  onTimeArrival: 0.9,
  baseline: {
    utilization: 0.71,
    rehandleCount: 19,
    rehandleMinutes: 95,
    wrongTrailerCount: 6,
    missedUnloadCount: 4,
    slaViolationRate: 0.12,
    onTimeDeparture: 0.81,
    onTimeArrival: 0.78,
  },
};

/** Read the rendered value text for a card field (via its stable test id). */
function valueOf(field: string): string {
  return screen.getByTestId(`kpi-value-${field}`).textContent ?? "";
}

describe("<KpiDashboard /> (jsdom ui lane)", () => {
  it("renders the zero / loading state with '—' on-time before the fetch resolves", () => {
    // Hold the fetch open (never resolves) so we observe the pre-fetch state.
    server.use(
      http.get("/api/kpis", () => new Promise<never>(() => {})),
    );

    render(<KpiDashboard />);

    // The dashboard shell mounts immediately with all 8 cards.
    expect(screen.getByTestId("kpi-dashboard")).toBeInTheDocument();
    expect(screen.getAllByTestId(/^kpi-card-/)).toHaveLength(8);

    // ZERO_SNAPSHOT defaults: counts/rates are 0, on-time fields are honest null.
    expect(valueOf("utilization")).toBe("0.0%");
    expect(valueOf("rehandleCount")).toBe("0");
    expect(valueOf("rehandleMinutes")).toBe("0.0 min");
    // F-03: never a fabricated 100% — the no-data on-time fields render an em-dash.
    expect(valueOf("onTimeDeparture")).toBe("—");
    expect(valueOf("onTimeArrival")).toBe("—");
  });

  it("renders all 8 populated metrics with formatted values from GET /api/kpis", async () => {
    // The default shared handler already serves `KPIS`; assert each card formats.
    render(<KpiDashboard />);

    await waitFor(() => {
      expect(valueOf("utilization")).toBe("82.0%");
    });

    // Percent / fraction fields.
    expect(valueOf("slaViolationRate")).toBe("4.0%");
    expect(valueOf("onTimeDeparture")).toBe("93.0%");
    expect(valueOf("onTimeArrival")).toBe("90.0%");
    // Count fields.
    expect(valueOf("rehandleCount")).toBe("7");
    expect(valueOf("wrongTrailerCount")).toBe("2");
    expect(valueOf("missedUnloadCount")).toBe("1");
    // Minutes field.
    expect(valueOf("rehandleMinutes")).toBe("35.0 min");

    // Every card carries its label (single source of truth: kpiCards()).
    for (const card of kpiCards()) {
      const el = screen.getByTestId(`kpi-card-${card.field}`);
      expect(within(el).getByText(card.label)).toBeInTheDocument();
    }
  });

  it("renders '—' for the null on-time branches (F-03 honest no-data)", async () => {
    // Override the boundary to report on-time metrics as unavailable (null).
    const nullOnTime: KpiSnapshot = {
      ...DEFAULT_KPIS,
      onTimeDeparture: null,
      onTimeArrival: null,
    };
    server.use(http.get("/api/kpis", () => HttpResponse.json(nullOnTime)));

    render(<KpiDashboard />);

    // Wait for the populated (non-on-time) value to confirm the fetch landed.
    await waitFor(() => {
      expect(valueOf("utilization")).toBe("82.0%");
    });

    // The null on-time fields render an em-dash, never a fabricated percentage.
    expect(valueOf("onTimeDeparture")).toBe("—");
    expect(valueOf("onTimeArrival")).toBe("—");
  });

  it("keeps the honest zero state when the initial fetch errors (no crash)", async () => {
    server.use(
      http.get("/api/kpis", () => new HttpResponse(null, { status: 500 })),
    );

    render(<KpiDashboard />);

    // The component swallows the error and leaves the zero-state snapshot.
    // Give the rejected fetch a microtask to settle, then assert the em-dash.
    await waitFor(() => {
      expect(valueOf("rehandleCount")).toBe("0");
    });
    expect(valueOf("onTimeDeparture")).toBe("—");
    expect(valueOf("onTimeArrival")).toBe("—");
    // No animation should have fired on an errored load.
    expect(screen.getByTestId("kpi-value-rehandleCount")).toHaveAttribute(
      "data-animating",
      "false",
    );
  });

  it("refetches on a ws tick and flashes the changed field (mergeLiveKpis path)", async () => {
    // First GET → initial values; subsequent GETs (driven by the ws snapshot +
    // tick the MSW ws channel auto-sends) → a CHANGED rehandleCount so the
    // animation branch fires and the `--animating` class is applied.
    let call = 0;
    server.use(
      http.get("/api/kpis", () => {
        call += 1;
        const value: KpiSnapshot =
          call === 1
            ? DEFAULT_KPIS
            : { ...DEFAULT_KPIS, rehandleCount: 11 };
        return HttpResponse.json(value);
      }),
    );

    render(
      <WsProvider>
        <KpiDashboard />
      </WsProvider>,
    );

    // The ws snapshot+tick trigger refetches; the new value (11) is merged via
    // mergeLiveKpis and the changed field flashes (kpi-card--animating +
    // data-animating="true"). The initial "7" REST value may be superseded
    // before the first assertion runs, so we assert the post-refetch value.
    await waitFor(() => {
      expect(valueOf("rehandleCount")).toBe("11");
    });
    // At least two GETs occurred: the initial mount fetch + ws-driven refetch.
    expect(call).toBeGreaterThanOrEqual(2);
    await waitFor(() => {
      expect(screen.getByTestId("kpi-card-rehandleCount")).toHaveClass(
        "kpi-card--animating",
      );
    });
    expect(screen.getByTestId("kpi-value-rehandleCount")).toHaveAttribute(
      "data-animating",
      "true",
    );

    // An unchanged field must NOT be flagged as animating.
    expect(screen.getByTestId("kpi-card-utilization")).not.toHaveClass(
      "kpi-card--animating",
    );
  });
});
