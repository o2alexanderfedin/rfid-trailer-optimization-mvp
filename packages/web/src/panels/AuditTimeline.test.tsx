/**
 * AuditTimeline tests — pure helpers (Node-style) + jsdom render coverage (`ui` lane).
 *
 * Pure helpers:
 *   - sortTimeline: orders entries by globalSeq ascending (oldest first)
 *   - formatTimelineEntry: formats a history entry for display
 *   - hasRecommendation: predicate — true iff the entry carries a recommendation
 *
 * Component render (the part that took coverage from ~18% → ~90%):
 *   - the no-selection prompt (entityId === null)
 *   - the error state when the history endpoint fails
 *   - the empty state for an entity with no history
 *   - the populated, oldest→newest ordered list (numeric globalSeq, not lexicographic)
 *   - label formatting (`eventType` and `eventType @ hubId`)
 *   - the highlighted recommendation row + `--has-recommendation` modifier class
 *   - package vs trailer header wording (and the correct endpoint per `kind`)
 *
 * The component fetches `GET /api/{trailers|packages}/:id/history` via the typed
 * client helpers, so each render case installs a per-test MSW override with
 * `server.use(...)` (the shared handlers.ts is intentionally NOT edited).
 */
import { describe, expect, it } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../test/msw/server.js";
import {
  AuditTimeline,
  sortTimeline,
  formatTimelineEntry,
  hasRecommendation,
} from "./AuditTimeline.js";
import type { TrailerHistoryEntryDto } from "../api/client.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntry(
  overrides: Partial<TrailerHistoryEntryDto> & Pick<TrailerHistoryEntryDto, "globalSeq">,
): TrailerHistoryEntryDto {
  return {
    globalSeq: overrides.globalSeq,
    eventType: overrides.eventType ?? "TrailerDeparted",
    occurredAt: overrides.occurredAt ?? "2026-06-19T10:00:00Z",
    // Honor an *explicit* `hubId: null` (the no-hub case); only default when
    // the key is absent — `?? "MEM"` would wrongly coalesce an explicit null.
    hubId: "hubId" in overrides ? (overrides.hubId ?? null) : "MEM",
    scanType: overrides.scanType ?? null,
    recommendation: overrides.recommendation ?? null,
  };
}

/** Install a trailer-history MSW override returning the given entries. */
function stubTrailerHistory(entries: readonly TrailerHistoryEntryDto[]): void {
  server.use(
    http.get("/api/trailers/:id/history", () => HttpResponse.json(entries)),
  );
}

/** Install a package-history MSW override returning the given entries. */
function stubPackageHistory(entries: readonly TrailerHistoryEntryDto[]): void {
  server.use(
    http.get("/api/packages/:id/history", () => HttpResponse.json(entries)),
  );
}

// ---------------------------------------------------------------------------
// sortTimeline
// ---------------------------------------------------------------------------

describe("sortTimeline", () => {
  it("sorts entries by globalSeq ascending (oldest first)", () => {
    const entries: TrailerHistoryEntryDto[] = [
      makeEntry({ globalSeq: "10" }),
      makeEntry({ globalSeq: "3" }),
      makeEntry({ globalSeq: "7" }),
    ];
    const sorted = sortTimeline(entries);
    expect(sorted[0]?.globalSeq).toBe("3");
    expect(sorted[1]?.globalSeq).toBe("7");
    expect(sorted[2]?.globalSeq).toBe("10");
  });

  it("handles numeric string comparison correctly (not lexicographic)", () => {
    const entries: TrailerHistoryEntryDto[] = [
      makeEntry({ globalSeq: "9" }),
      makeEntry({ globalSeq: "10" }),
      makeEntry({ globalSeq: "2" }),
    ];
    const sorted = sortTimeline(entries);
    expect(sorted[0]?.globalSeq).toBe("2");
    expect(sorted[1]?.globalSeq).toBe("9");
    expect(sorted[2]?.globalSeq).toBe("10");
  });

  it("does not mutate the original array", () => {
    const entries: TrailerHistoryEntryDto[] = [
      makeEntry({ globalSeq: "5" }),
      makeEntry({ globalSeq: "1" }),
    ];
    const original = [entries[0]!.globalSeq, entries[1]!.globalSeq];
    sortTimeline(entries);
    expect(entries[0]?.globalSeq).toBe(original[0]);
    expect(entries[1]?.globalSeq).toBe(original[1]);
  });

  it("returns empty array for empty input", () => {
    expect(sortTimeline([])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// formatTimelineEntry
// ---------------------------------------------------------------------------

describe("formatTimelineEntry", () => {
  it("returns an object with a non-empty label", () => {
    const entry = makeEntry({ globalSeq: "1", eventType: "TrailerDeparted" });
    const formatted = formatTimelineEntry(entry);
    expect(typeof formatted.label).toBe("string");
    expect(formatted.label.length).toBeGreaterThan(0);
  });

  it("includes the eventType in the label", () => {
    const entry = makeEntry({ globalSeq: "1", eventType: "PlanGenerated" });
    const formatted = formatTimelineEntry(entry);
    expect(formatted.label).toContain("PlanGenerated");
  });

  it("uses the bare eventType when there is no hub", () => {
    const formatted = formatTimelineEntry(
      makeEntry({ globalSeq: "1", eventType: "PlanComputed", hubId: null }),
    );
    expect(formatted.label).toBe("PlanComputed");
    expect(formatted.hubId).toBeNull();
  });

  it("appends `@ hubId` to the label when a hub is present", () => {
    const formatted = formatTimelineEntry(
      makeEntry({ globalSeq: "1", eventType: "TrailerDeparted", hubId: "LAX" }),
    );
    expect(formatted.label).toBe("TrailerDeparted @ LAX");
  });

  it("includes the hubId when present", () => {
    const entry = makeEntry({ globalSeq: "1", hubId: "ORD" });
    const formatted = formatTimelineEntry(entry);
    expect(formatted.hubId).toBe("ORD");
  });

  it("includes the recommendation when present", () => {
    const entry = makeEntry({
      globalSeq: "1",
      recommendation: "Assign to route ORD-MEM for optimal LIFO order",
    });
    const formatted = formatTimelineEntry(entry);
    expect(formatted.recommendation).toBe(
      "Assign to route ORD-MEM for optimal LIFO order",
    );
  });

  it("recommendation is null when not set", () => {
    const entry = makeEntry({ globalSeq: "1", recommendation: null });
    const formatted = formatTimelineEntry(entry);
    expect(formatted.recommendation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hasRecommendation
// ---------------------------------------------------------------------------

describe("hasRecommendation", () => {
  it("returns true when recommendation is non-empty string", () => {
    const entry = makeEntry({
      globalSeq: "1",
      recommendation: "Some recommendation",
    });
    expect(hasRecommendation(entry)).toBe(true);
  });

  it("returns false when recommendation is null", () => {
    const entry = makeEntry({ globalSeq: "1", recommendation: null });
    expect(hasRecommendation(entry)).toBe(false);
  });

  it("returns false when recommendation is empty string", () => {
    const entry = makeEntry({ globalSeq: "1", recommendation: "" });
    expect(hasRecommendation(entry)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Component — no selection
// ---------------------------------------------------------------------------

describe("AuditTimeline (no selection)", () => {
  it("renders the prompt and fetches nothing when entityId is null", () => {
    render(<AuditTimeline kind="trailer" entityId={null} />);
    expect(screen.getByTestId("audit-timeline")).toBeInTheDocument();
    expect(
      screen.getByText("Select a trailer or package to view its history."),
    ).toBeInTheDocument();
    // No entries rendered without a selection.
    expect(screen.queryByTestId("audit-timeline-entry")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Component — populated timeline
// ---------------------------------------------------------------------------

describe("AuditTimeline (populated)", () => {
  it("renders trailer entries oldest→newest with the trailer header", async () => {
    stubTrailerHistory([
      makeEntry({
        globalSeq: "10",
        eventType: "TrailerDeparted",
        hubId: "DFW",
        occurredAt: "2026-06-21T02:00:00.000Z",
      }),
      makeEntry({
        globalSeq: "2",
        eventType: "PlanComputed",
        hubId: "LAX",
        occurredAt: "2026-06-21T00:00:00.000Z",
      }),
    ]);

    render(<AuditTimeline kind="trailer" entityId="T-100" />);

    // Header identifies the entity as a trailer and carries its id (the id is
    // interpolated into the same element, so assert the combined header text).
    expect(await screen.findByText(/Trailer:\s*T-100/)).toBeInTheDocument();

    const entries = screen.getAllByTestId("audit-timeline-entry");
    expect(entries).toHaveLength(2);

    // Ordered oldest→newest: globalSeq 2 (numeric) precedes globalSeq 10.
    expect(entries[0]).toHaveAttribute("data-seq", "2");
    expect(entries[1]).toHaveAttribute("data-seq", "10");

    // Labels carry the eventType and the `@ hub` suffix.
    expect(within(entries[0]!).getByText("PlanComputed @ LAX")).toBeInTheDocument();
    expect(
      within(entries[1]!).getByText("TrailerDeparted @ DFW"),
    ).toBeInTheDocument();

    // The occurredAt timestamp is rendered as a machine-readable <time>.
    const time = within(entries[0]!).getByText("2026-06-21T00:00:00.000Z");
    expect(time).toHaveAttribute("dateTime", "2026-06-21T00:00:00.000Z");
  });

  it("highlights an entry that carries a recommendation and shows the text", async () => {
    stubTrailerHistory([
      makeEntry({
        globalSeq: "1",
        eventType: "PlanComputed",
        hubId: "LAX",
        recommendation: "Reroute P-9 to T-200",
      }),
      makeEntry({
        globalSeq: "2",
        eventType: "TrailerArrived",
        hubId: "DFW",
        recommendation: null,
      }),
    ]);

    render(<AuditTimeline kind="trailer" entityId="T-100" />);

    const entries = await screen.findAllByTestId("audit-timeline-entry");

    // The decision entry is visually highlighted; the plain one is not.
    expect(entries[0]).toHaveClass("audit-timeline__entry--has-recommendation");
    expect(entries[1]).not.toHaveClass(
      "audit-timeline__entry--has-recommendation",
    );

    // The recommendation row appears only for the decision entry.
    const recRows = screen.getAllByTestId("audit-timeline-recommendation");
    expect(recRows).toHaveLength(1);
    expect(recRows[0]).toHaveTextContent("Recommendation:");
    expect(recRows[0]).toHaveTextContent("Reroute P-9 to T-200");
  });

  it("renders package entries with the package header and hits the package endpoint", async () => {
    stubPackageHistory([
      makeEntry({
        globalSeq: "5",
        eventType: "PackageScanned",
        hubId: null,
        recommendation: null,
      }),
    ]);

    render(<AuditTimeline kind="package" entityId="P-9" />);

    expect(await screen.findByText(/Package:\s*P-9/)).toBeInTheDocument();

    const entry = screen.getByTestId("audit-timeline-entry");
    // No hub → bare eventType label, no `@` suffix.
    expect(within(entry).getByText("PackageScanned")).toBeInTheDocument();
    expect(
      screen.queryByTestId("audit-timeline-recommendation"),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Component — empty / error states
// ---------------------------------------------------------------------------

describe("AuditTimeline (empty + error)", () => {
  it("renders the empty state when the entity has no history", async () => {
    stubTrailerHistory([]);

    render(<AuditTimeline kind="trailer" entityId="T-empty" />);

    expect(
      await screen.findByText("No history found for trailer T-empty."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("audit-timeline-entry")).not.toBeInTheDocument();
  });

  it("renders the empty state for an unknown package", async () => {
    stubPackageHistory([]);

    render(<AuditTimeline kind="package" entityId="P-unknown" />);

    expect(
      await screen.findByText("No history found for package P-unknown."),
    ).toBeInTheDocument();
  });

  it("renders the error state when the history endpoint fails", async () => {
    server.use(
      http.get(
        "/api/trailers/:id/history",
        () => new HttpResponse(null, { status: 500 }),
      ),
    );

    render(<AuditTimeline kind="trailer" entityId="T-boom" />);

    await waitFor(() => {
      const timeline = screen.getByTestId("audit-timeline");
      expect(timeline).toHaveTextContent(/Error:/);
    });
    expect(screen.getByTestId("audit-timeline")).toHaveTextContent(/500/);
  });
});
