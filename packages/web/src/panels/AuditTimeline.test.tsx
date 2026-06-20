/**
 * AuditTimeline tests (TDD RED→GREEN).
 *
 * Tests the pure logic helpers for the audit timeline panel:
 *   - sortTimeline: orders entries by globalSeq ascending (oldest first)
 *   - formatTimelineEntry: formats a history entry for display
 *   - hasRecommendation: predicate — true iff the entry carries a recommendation
 *
 * The component renders React JSX; helpers are extracted for Node-friendly testing.
 */
import { describe, expect, it } from "vitest";
import {
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
    hubId: overrides.hubId ?? "MEM",
    scanType: overrides.scanType ?? null,
    recommendation: overrides.recommendation ?? null,
  };
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
