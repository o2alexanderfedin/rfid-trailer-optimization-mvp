/**
 * AlertFeed tests (TDD RED→GREEN).
 *
 * Tests the pure alert-feed state management:
 *   - applyExceptionsNew: appends entries to the feed
 *   - applyExceptionsResolved: removes entries by id
 *   - sortFeed: newest first (by simMs), stable tie-break by id
 *   - severityClass: returns the correct CSS class for each severity
 *   - kindLabel: returns the human-readable label for each kind
 *
 * The component renders via React hooks, but the logic is extracted into
 * pure functions matching the existing project pattern (no DOM/browser needed).
 */
import { describe, expect, it } from "vitest";
import {
  applyExceptionsNew,
  applyExceptionsResolved,
  sortFeed,
  severityClass,
  kindLabel,
  MAX_FEED_ENTRIES,
  type FeedEntry,
} from "./AlertFeed.js";
import type { ExceptionItem } from "@mm/api";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeException(
  overrides: Partial<ExceptionItem> & Pick<ExceptionItem, "id">,
): ExceptionItem {
  return {
    id: overrides.id,
    kind: overrides.kind ?? "wrongTrailer",
    severity: overrides.severity ?? "high",
    entityId: overrides.entityId ?? "T-1",
    reason: overrides.reason ?? "Package scanned on wrong trailer",
    recommendedAction: overrides.recommendedAction ?? "Reroute to T-2",
    simMs: overrides.simMs ?? 1000,
  };
}

function makeEntry(
  overrides: Partial<ExceptionItem> & Pick<ExceptionItem, "id">,
): FeedEntry {
  return makeException(overrides);
}

// ---------------------------------------------------------------------------
// applyExceptionsNew
// ---------------------------------------------------------------------------

describe("applyExceptionsNew", () => {
  it("appends new exceptions to an empty feed", () => {
    const ex = makeException({ id: "ex-1" });
    const result = applyExceptionsNew([], [ex]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("ex-1");
  });

  it("appends multiple new exceptions", () => {
    const ex1 = makeException({ id: "ex-1", simMs: 100 });
    const ex2 = makeException({ id: "ex-2", simMs: 200 });
    const result = applyExceptionsNew([], [ex1, ex2]);
    expect(result).toHaveLength(2);
  });

  it("does not add duplicate ids", () => {
    const ex = makeException({ id: "ex-1" });
    const result = applyExceptionsNew([ex], [ex]);
    expect(result).toHaveLength(1);
  });

  it("appends to existing entries (not duplicate)", () => {
    const existing = makeEntry({ id: "ex-1", simMs: 100 });
    const newEx = makeException({ id: "ex-2", simMs: 200 });
    const result = applyExceptionsNew([existing], [newEx]);
    expect(result).toHaveLength(2);
  });

  it("caps the feed at MAX_FEED_ENTRIES by dropping oldest", () => {
    const existing: FeedEntry[] = Array.from({ length: MAX_FEED_ENTRIES }, (_, i) =>
      makeEntry({ id: `ex-old-${i}`, simMs: i }),
    );
    const newEx = makeException({ id: "ex-new", simMs: MAX_FEED_ENTRIES + 1 });
    const result = applyExceptionsNew(existing, [newEx]);
    expect(result).toHaveLength(MAX_FEED_ENTRIES);
    // Newest should be retained (highest simMs), oldest dropped.
    expect(result.some((e) => e.id === "ex-new")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyExceptionsResolved
// ---------------------------------------------------------------------------

describe("applyExceptionsResolved", () => {
  it("removes an entry by id", () => {
    const feed: FeedEntry[] = [
      makeEntry({ id: "ex-1" }),
      makeEntry({ id: "ex-2" }),
    ];
    const result = applyExceptionsResolved(feed, ["ex-1"]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("ex-2");
  });

  it("removes multiple ids", () => {
    const feed: FeedEntry[] = [
      makeEntry({ id: "ex-1" }),
      makeEntry({ id: "ex-2" }),
      makeEntry({ id: "ex-3" }),
    ];
    const result = applyExceptionsResolved(feed, ["ex-1", "ex-3"]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("ex-2");
  });

  it("returns same feed when id not found (no crash)", () => {
    const feed: FeedEntry[] = [makeEntry({ id: "ex-1" })];
    const result = applyExceptionsResolved(feed, ["nonexistent"]);
    expect(result).toHaveLength(1);
  });

  it("returns empty array when all removed", () => {
    const feed: FeedEntry[] = [makeEntry({ id: "ex-1" })];
    const result = applyExceptionsResolved(feed, ["ex-1"]);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sortFeed
// ---------------------------------------------------------------------------

describe("sortFeed", () => {
  it("sorts newest first by simMs", () => {
    const feed: FeedEntry[] = [
      makeEntry({ id: "ex-a", simMs: 100 }),
      makeEntry({ id: "ex-b", simMs: 300 }),
      makeEntry({ id: "ex-c", simMs: 200 }),
    ];
    const sorted = sortFeed(feed);
    expect(sorted[0]?.simMs).toBe(300);
    expect(sorted[1]?.simMs).toBe(200);
    expect(sorted[2]?.simMs).toBe(100);
  });

  it("stable tie-break by id (alphabetical ascending) when simMs equal", () => {
    const feed: FeedEntry[] = [
      makeEntry({ id: "ex-b", simMs: 100 }),
      makeEntry({ id: "ex-a", simMs: 100 }),
    ];
    const sorted = sortFeed(feed);
    // Both same simMs, tie-break by id ascending: ex-a < ex-b → ex-a first.
    expect(sorted[0]?.id).toBe("ex-a");
    expect(sorted[1]?.id).toBe("ex-b");
  });

  it("does not mutate the original array", () => {
    const feed: FeedEntry[] = [
      makeEntry({ id: "ex-b", simMs: 200 }),
      makeEntry({ id: "ex-a", simMs: 100 }),
    ];
    const original = [...feed];
    sortFeed(feed);
    expect(feed[0]?.id).toBe(original[0]?.id);
  });
});

// ---------------------------------------------------------------------------
// severityClass
// ---------------------------------------------------------------------------

describe("severityClass", () => {
  it("returns the low-severity CSS class", () => {
    expect(severityClass("low")).toMatch(/low/);
  });

  it("returns the med-severity CSS class", () => {
    expect(severityClass("med")).toMatch(/med/);
  });

  it("returns the high-severity CSS class", () => {
    expect(severityClass("high")).toMatch(/high/);
  });

  it("returns distinct classes for different severities", () => {
    const low = severityClass("low");
    const med = severityClass("med");
    const high = severityClass("high");
    expect(low).not.toBe(med);
    expect(med).not.toBe(high);
    expect(low).not.toBe(high);
  });
});

// ---------------------------------------------------------------------------
// kindLabel
// ---------------------------------------------------------------------------

describe("kindLabel", () => {
  it("returns a human-readable label for wrongTrailer", () => {
    const label = kindLabel("wrongTrailer");
    expect(typeof label).toBe("string");
    expect(label.length).toBeGreaterThan(0);
    // Should be human-readable, not camelCase
    expect(label).not.toBe("wrongTrailer");
  });

  it("returns a human-readable label for missedUnload", () => {
    const label = kindLabel("missedUnload");
    expect(typeof label).toBe("string");
    expect(label).not.toBe("missedUnload");
  });

  it("returns a human-readable label for blockedFreight", () => {
    const label = kindLabel("blockedFreight");
    expect(typeof label).toBe("string");
    expect(label).not.toBe("blockedFreight");
  });

  it("returns a human-readable label for lowUtilization", () => {
    const label = kindLabel("lowUtilization");
    expect(typeof label).toBe("string");
    expect(label).not.toBe("lowUtilization");
  });
});
