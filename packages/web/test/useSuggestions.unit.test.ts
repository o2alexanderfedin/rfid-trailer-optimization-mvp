/**
 * Unit tests for useSuggestions / SuggestionFeed pure helpers (VIZ-17).
 *
 * Tests run in Node (no DOM) — same pattern as AlertFeed tests.
 * Import only the pure helpers exported from useSuggestions.ts, NOT the
 * React hook or the SuggestionFeed component.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_FEED_ENTRIES,
  applySuggestions,
  sortSuggestionFeed,
  suggestionKindLabel,
  type SuggestionFeedEntry,
} from "../src/panels/useSuggestions.js";
import type { SuggestionEvent } from "@mm/api";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSuggestion(
  overrides: Partial<SuggestionEvent> & { suggestionId: string },
): SuggestionEvent {
  return {
    kind: "reroute",
    outcome: "accepted",
    entityId: "trailer-42",
    toHubId: "hub-bos",
    locationHubId: "hub-bos",
    ...overrides,
  };
}

function makeEntry(
  overrides: Partial<SuggestionFeedEntry> & { suggestionId: string; simMs: number },
): SuggestionFeedEntry {
  const base: SuggestionFeedEntry = {
    kind: "reroute",
    outcome: "accepted",
    entityId: "trailer-42",
    toHubId: "hub-bos",
    ...overrides,
  };
  return base;
}

// ---------------------------------------------------------------------------
// MAX_FEED_ENTRIES cap
// ---------------------------------------------------------------------------

describe("MAX_FEED_ENTRIES", () => {
  it("is 200", () => {
    expect(MAX_FEED_ENTRIES).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// applySuggestions
// ---------------------------------------------------------------------------

describe("applySuggestions", () => {
  it("appends new suggestions to an empty feed", () => {
    const incoming = [makeSuggestion({ suggestionId: "s1" })];
    const result = applySuggestions([], incoming, 1000);
    expect(result).toHaveLength(1);
    expect(result[0]?.suggestionId).toBe("s1");
    expect(result[0]?.simMs).toBe(1000);
  });

  it("deduplicates by suggestionId", () => {
    const existing: SuggestionFeedEntry[] = [
      makeEntry({ suggestionId: "s1", simMs: 1000 }),
    ];
    const incoming = [makeSuggestion({ suggestionId: "s1" })];
    const result = applySuggestions(existing, incoming, 2000);
    expect(result).toHaveLength(1);
    expect(result[0]?.simMs).toBe(1000); // existing entry, not the new duplicate
  });

  it("does not deduplicate entries with different suggestionIds", () => {
    const existing: SuggestionFeedEntry[] = [
      makeEntry({ suggestionId: "s1", simMs: 1000 }),
    ];
    const incoming = [makeSuggestion({ suggestionId: "s2" })];
    const result = applySuggestions(existing, incoming, 2000);
    expect(result).toHaveLength(2);
  });

  it("attaches the current simMs to incoming entries", () => {
    const incoming = [makeSuggestion({ suggestionId: "s1" })];
    const result = applySuggestions([], incoming, 9999);
    expect(result[0]?.simMs).toBe(9999);
  });

  it("propagates outcome, kind, entityId, toHubId, reasonCode from the event", () => {
    const incoming = [
      makeSuggestion({
        suggestionId: "s1",
        kind: "hold",
        outcome: "rejected",
        entityId: "trailer-7",
        toHubId: "hub-ord",
        reasonCode: "fuel",
      }),
    ];
    const result = applySuggestions([], incoming, 500);
    expect(result[0]).toMatchObject({
      suggestionId: "s1",
      kind: "hold",
      outcome: "rejected",
      entityId: "trailer-7",
      toHubId: "hub-ord",
      reasonCode: "fuel",
    });
  });

  it("caps at MAX_FEED_ENTRIES and drops oldest by simMs", () => {
    const existing: SuggestionFeedEntry[] = Array.from(
      { length: MAX_FEED_ENTRIES },
      (_, i) => makeEntry({ suggestionId: `s${i}`, simMs: i }),
    );
    // Add one more — the oldest (simMs=0) should be dropped.
    const incoming = [makeSuggestion({ suggestionId: "sNew" })];
    const result = applySuggestions(existing, incoming, MAX_FEED_ENTRIES);
    expect(result).toHaveLength(MAX_FEED_ENTRIES);
    // The oldest entry (simMs=0, id=s0) should be gone.
    expect(result.find((e) => e.suggestionId === "s0")).toBeUndefined();
    // The new entry should be present.
    expect(result.find((e) => e.suggestionId === "sNew")).toBeDefined();
  });

  it("drops oldest by stable id tiebreak when simMs equals", () => {
    const existing: SuggestionFeedEntry[] = Array.from(
      { length: MAX_FEED_ENTRIES },
      (_, i) => makeEntry({ suggestionId: `s${String(i).padStart(4, "0")}`, simMs: 0 }),
    );
    const incoming = [makeSuggestion({ suggestionId: "z_last" })];
    const result = applySuggestions(existing, incoming, 0);
    expect(result).toHaveLength(MAX_FEED_ENTRIES);
    // "s0000" < "s0001" < ... so s0000 is the OLDEST alphabetically and should drop.
    expect(result.find((e) => e.suggestionId === "s0000")).toBeUndefined();
    expect(result.find((e) => e.suggestionId === "z_last")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// sortSuggestionFeed
// ---------------------------------------------------------------------------

describe("sortSuggestionFeed", () => {
  it("returns entries newest-first by simMs", () => {
    const feed: SuggestionFeedEntry[] = [
      makeEntry({ suggestionId: "a", simMs: 1000 }),
      makeEntry({ suggestionId: "b", simMs: 3000 }),
      makeEntry({ suggestionId: "c", simMs: 2000 }),
    ];
    const sorted = sortSuggestionFeed(feed);
    expect(sorted.map((e) => e.suggestionId)).toEqual(["b", "c", "a"]);
  });

  it("stable tie-breaks by suggestionId ascending on equal simMs", () => {
    const feed: SuggestionFeedEntry[] = [
      makeEntry({ suggestionId: "z", simMs: 1000 }),
      makeEntry({ suggestionId: "a", simMs: 1000 }),
      makeEntry({ suggestionId: "m", simMs: 1000 }),
    ];
    const sorted = sortSuggestionFeed(feed);
    expect(sorted.map((e) => e.suggestionId)).toEqual(["a", "m", "z"]);
  });

  it("does NOT mutate the input array", () => {
    const feed: SuggestionFeedEntry[] = [
      makeEntry({ suggestionId: "b", simMs: 2000 }),
      makeEntry({ suggestionId: "a", simMs: 1000 }),
    ];
    const original = [...feed];
    sortSuggestionFeed(feed);
    expect(feed.map((e) => e.suggestionId)).toEqual(
      original.map((e) => e.suggestionId),
    );
  });
});

// ---------------------------------------------------------------------------
// suggestionKindLabel
// ---------------------------------------------------------------------------

describe("suggestionKindLabel", () => {
  it("returns title-case labels for all four kinds", () => {
    expect(suggestionKindLabel("reroute")).toBe("Reroute");
    expect(suggestionKindLabel("hold")).toBe("Hold");
    expect(suggestionKindLabel("consolidate")).toBe("Consolidate");
    expect(suggestionKindLabel("dispatch")).toBe("Dispatch");
  });
});
