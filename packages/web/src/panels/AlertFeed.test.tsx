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
import { act, render, renderHook, screen, within } from "@testing-library/react";
import {
  AlertFeed,
  applyExceptionsNew,
  applyExceptionsResolved,
  sortFeed,
  severityClass,
  kindLabel,
  useAlertFeed,
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

// ---------------------------------------------------------------------------
// <AlertFeed /> — jsdom render (ui lane)
//
// Renders the real component to cover the JSX branches that the pure-helper
// tests cannot reach:
//  - the empty-state branch (feed.length === 0)
//  - the populated branch: one entry row per item, with the human-readable
//    kind label, the UPPERCASED severity badge, severity/kind class + data-*
//    attributes, and the server's reason / recommendedAction / entityId text
//  - all four kinds and all three severities render distinctly
//  - text is rendered via React escaping (no dangerouslySetInnerHTML) so a
//    payload that looks like markup is shown verbatim (T-05-16)
// ---------------------------------------------------------------------------

describe("<AlertFeed /> (jsdom ui lane)", () => {
  it("renders the empty state when the feed has no entries", () => {
    render(<AlertFeed feed={[]} />);

    expect(screen.getByTestId("alert-feed")).toBeInTheDocument();
    const empty = screen.getByTestId("alert-feed-empty");
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveTextContent("No active exceptions");
    // The empty branch renders no entry rows.
    expect(screen.queryAllByTestId("alert-feed-entry")).toHaveLength(0);
  });

  it("renders one entry row per feed item", () => {
    const feed: FeedEntry[] = [
      makeEntry({ id: "ex-1", simMs: 300 }),
      makeEntry({ id: "ex-2", simMs: 200 }),
      makeEntry({ id: "ex-3", simMs: 100 }),
    ];
    render(<AlertFeed feed={feed} />);

    expect(screen.getByTestId("alert-feed")).toBeInTheDocument();
    expect(screen.getAllByTestId("alert-feed-entry")).toHaveLength(3);
    // The empty-state node is absent when populated.
    expect(screen.queryByTestId("alert-feed-empty")).toBeNull();
  });

  it("renders the kind label, uppercased severity badge, and server text for an entry", () => {
    const feed: FeedEntry[] = [
      makeEntry({
        id: "ex-1",
        kind: "blockedFreight",
        severity: "high",
        entityId: "T-42",
        reason: "Freight behind a closer-unload block",
        recommendedAction: "Over-carry to next hub",
      }),
    ];
    render(<AlertFeed feed={feed} />);

    const entry = screen.getByTestId("alert-feed-entry");
    // Severity + kind are exposed as stable data-* hooks.
    expect(entry).toHaveAttribute("data-severity", "high");
    expect(entry).toHaveAttribute("data-kind", "blockedFreight");
    // The entry carries the severity-coded class suffix.
    expect(entry).toHaveClass(severityClass("high"));

    // Human-readable kind label (not the raw camelCase enum).
    expect(within(entry).getByText(kindLabel("blockedFreight"))).toBeInTheDocument();
    expect(within(entry).queryByText("blockedFreight")).toBeNull();
    // Severity badge is UPPERCASED.
    expect(within(entry).getByText("HIGH")).toBeInTheDocument();
    // Server-supplied plain-English fields render verbatim.
    expect(within(entry).getByText("T-42")).toBeInTheDocument();
    expect(
      within(entry).getByText("Freight behind a closer-unload block"),
    ).toBeInTheDocument();
    expect(within(entry).getByText("Over-carry to next hub")).toBeInTheDocument();
  });

  it("renders all four exception kinds with their labels and data-kind hooks", () => {
    const kinds: ExceptionItem["kind"][] = [
      "wrongTrailer",
      "missedUnload",
      "blockedFreight",
      "lowUtilization",
    ];
    const feed: FeedEntry[] = kinds.map((kind, i) =>
      makeEntry({ id: `ex-${kind}`, kind, simMs: i }),
    );
    render(<AlertFeed feed={feed} />);

    const entries = screen.getAllByTestId("alert-feed-entry");
    expect(entries).toHaveLength(4);

    const renderedKinds = entries.map((el) => el.getAttribute("data-kind"));
    for (const kind of kinds) {
      expect(renderedKinds).toContain(kind);
      // The matching row shows the human-readable label.
      const row = entries.find((el) => el.getAttribute("data-kind") === kind);
      expect(row).toBeDefined();
      expect(within(row as HTMLElement).getByText(kindLabel(kind))).toBeInTheDocument();
    }
  });

  it("renders each severity's uppercased badge and severity-coded class", () => {
    const severities: ExceptionItem["severity"][] = ["low", "med", "high"];
    const feed: FeedEntry[] = severities.map((severity, i) =>
      makeEntry({ id: `ex-${severity}`, severity, simMs: i }),
    );
    render(<AlertFeed feed={feed} />);

    const entries = screen.getAllByTestId("alert-feed-entry");
    expect(entries).toHaveLength(3);

    for (const severity of severities) {
      const row = entries.find(
        (el) => el.getAttribute("data-severity") === severity,
      );
      expect(row).toBeDefined();
      const el = row as HTMLElement;
      expect(el).toHaveClass(severityClass(severity));
      expect(within(el).getByText(severity.toUpperCase())).toBeInTheDocument();
    }
  });

  it("renders untrusted text via React escaping — no markup injection (T-05-16)", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const feed: FeedEntry[] = [
      makeEntry({ id: "ex-xss", reason: evil, recommendedAction: evil }),
    ];
    render(<AlertFeed feed={feed} />);

    const entry = screen.getByTestId("alert-feed-entry");
    // The payload is shown as literal text, not parsed into an element.
    expect(within(entry).getAllByText(evil).length).toBeGreaterThan(0);
    // No injected <img> made it into the live DOM.
    expect(entry.querySelector("img")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// useAlertFeed — hook state management (jsdom ui lane)
//
// Drives the hook's delta handlers and the always-sorted `feed` it returns,
// covering the useState/useCallback wiring that the pure helpers don't.
// ---------------------------------------------------------------------------

describe("useAlertFeed (jsdom ui lane)", () => {
  it("starts with an empty feed", () => {
    const { result } = renderHook(() => useAlertFeed());
    expect(result.current.feed).toHaveLength(0);
  });

  it("onExceptionsNew adds entries and exposes them newest-first", () => {
    const { result } = renderHook(() => useAlertFeed());

    act(() => {
      result.current.onExceptionsNew([
        makeException({ id: "ex-old", simMs: 100 }),
        makeException({ id: "ex-new", simMs: 300 }),
      ]);
    });

    expect(result.current.feed).toHaveLength(2);
    // sortFeed → descending simMs, so the newest entry is first.
    expect(result.current.feed[0]?.id).toBe("ex-new");
    expect(result.current.feed[1]?.id).toBe("ex-old");
  });

  it("onExceptionsResolved removes entries by id", () => {
    const { result } = renderHook(() => useAlertFeed());

    act(() => {
      result.current.onExceptionsNew([
        makeException({ id: "ex-1", simMs: 100 }),
        makeException({ id: "ex-2", simMs: 200 }),
      ]);
    });
    act(() => {
      result.current.onExceptionsResolved(["ex-1"]);
    });

    expect(result.current.feed).toHaveLength(1);
    expect(result.current.feed[0]?.id).toBe("ex-2");
  });

  it("exposes stable handler references across renders (useCallback)", () => {
    const { result, rerender } = renderHook(() => useAlertFeed());
    const firstNew = result.current.onExceptionsNew;
    const firstResolved = result.current.onExceptionsResolved;

    rerender();

    expect(result.current.onExceptionsNew).toBe(firstNew);
    expect(result.current.onExceptionsResolved).toBe(firstResolved);
  });

  it("drives the rendered <AlertFeed /> from hook state end-to-end", () => {
    function Harness() {
      const { feed } = useAlertFeed();
      return <AlertFeed feed={feed} />;
    }
    render(<Harness />);
    // With no deltas applied the harness shows the empty state.
    expect(screen.getByTestId("alert-feed-empty")).toBeInTheDocument();
  });
});
