/**
 * useOpenExceptions tests (VIZ-10).
 *
 * Two surfaces (mirrors AlertFeed's test discipline):
 *  1. Pure helpers (node-style, no DOM):
 *     - applyOpenSnapshot / applyOpenDelta: maintain the open-exception set.
 *     - exceptionsForEntity: filter the open set by `entityId` (the VIZ-10 key —
 *       the ws `ExceptionItem.entityId` carries the trailerId).
 *  2. The hook: subscribes to the shared ws bus and exposes a stable lookup so
 *     each Hub Detail row can show its trailer's open alerts with NO extra fetch.
 */
import { describe, expect, it } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { ExceptionItem, WsEnvelope } from "@mm/api";
import {
  applyOpenSnapshot,
  applyOpenDelta,
  exceptionsForEntity,
  useOpenExceptions,
} from "./useOpenExceptions.js";
import { WsContext, makeSubscriberRegistry } from "../map/WsProvider.js";
import { makeEntityMaps } from "../map/wsClient.js";

function ex(id: string, entityId: string): ExceptionItem {
  return {
    id,
    kind: "wrongTrailer",
    severity: "high",
    entityId,
    reason: `reason ${id}`,
    recommendedAction: `action ${id}`,
    simMs: 1_000,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("applyOpenSnapshot", () => {
  it("replaces the open set with the snapshot list (resync semantics)", () => {
    const a = applyOpenSnapshot([], [ex("e1", "T-1"), ex("e2", "T-2")]);
    expect(a).toHaveLength(2);
    // A second snapshot replaces (does not append).
    const b = applyOpenSnapshot(a, [ex("e3", "T-3")]);
    expect(b).toHaveLength(1);
    expect(b[0]?.id).toBe("e3");
  });
});

describe("applyOpenDelta", () => {
  it("adds new exceptions (dedup by id) and removes resolved ids", () => {
    let s = applyOpenSnapshot([], [ex("e1", "T-1")]);
    s = applyOpenDelta(s, [ex("e2", "T-1"), ex("e1", "T-1")], []);
    expect(s).toHaveLength(2); // e1 deduped, e2 added
    s = applyOpenDelta(s, [], ["e1"]);
    expect(s.map((e) => e.id)).toEqual(["e2"]);
  });
});

describe("exceptionsForEntity (VIZ-10 entityId filter)", () => {
  it("returns only exceptions whose entityId matches the trailer", () => {
    const open = [ex("e1", "T-1"), ex("e2", "T-2"), ex("e3", "T-1")];
    const forT1 = exceptionsForEntity(open, "T-1");
    expect(forT1.map((e) => e.id).sort()).toEqual(["e1", "e3"]);
    expect(exceptionsForEntity(open, "T-9")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

function makeCtx() {
  return { registry: makeSubscriberRegistry(), maps: makeEntityMaps() };
}

const SPEED = { multiplier: 1, tickIntervalMs: 500, simSpeed: 120, paused: false } as const;

function snapshot(open: readonly ExceptionItem[]): WsEnvelope {
  return {
    v: 1,
    type: "snapshot",
    seq: 1,
    simMs: 0,
    simDay: 0,
    speed: SPEED,
    payload: { trailers: [], hubs: [], routes: [], exceptionsOpen: open },
  };
}

function tick(
  seq: number,
  newOnes: readonly ExceptionItem[],
  resolved: readonly string[],
): WsEnvelope {
  return {
    v: 1,
    type: "tick",
    seq,
    simMs: seq * 100,
    simDay: 0,
    speed: SPEED,
    payload: { exceptionsNew: newOnes, exceptionsResolved: resolved },
  };
}

/** Probe rendering the count of open exceptions for a given entity. */
function Probe({ entityId }: { entityId: string }): React.JSX.Element {
  const forEntity = useOpenExceptions();
  return <div data-testid="count">{forEntity(entityId).length}</div>;
}

describe("useOpenExceptions (jsdom ui lane)", () => {
  it("tracks the open set across snapshot + tick and filters by entityId", () => {
    const ctx = makeCtx();
    render(
      <WsContext.Provider value={ctx}>
        <Probe entityId="T-1" />
      </WsContext.Provider>,
    );
    expect(screen.getByTestId("count")).toHaveTextContent("0");

    act(() => {
      ctx.registry.dispatch(snapshot([ex("e1", "T-1"), ex("e2", "T-2")]));
    });
    expect(screen.getByTestId("count")).toHaveTextContent("1"); // only e1 → T-1

    act(() => {
      ctx.registry.dispatch(tick(2, [ex("e3", "T-1")], []));
    });
    expect(screen.getByTestId("count")).toHaveTextContent("2"); // e1 + e3

    act(() => {
      ctx.registry.dispatch(tick(3, [], ["e1"]));
    });
    expect(screen.getByTestId("count")).toHaveTextContent("1"); // e3 remains
  });
});
