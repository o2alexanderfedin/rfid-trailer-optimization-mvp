/**
 * ws envelope client (VIZ-02 / Q2 / Q3).
 *
 * Exports:
 *  - Pure functions (testable in Node, no DOM): `parseEnvelope`, `applySnapshot`,
 *    `applyTick`, `makeEntityMaps`.
 *  - React hook: `useWsEnvelope` — single socket, handler in a ref (no re-open on
 *    closure change), seq-gap detection, resync-on-gap, all off the React render path.
 *
 * Realtime discipline (Phase-1 + Q3):
 *  - The WebSocket is opened ONCE per mount; handler is a ref so a changing
 *    onEnvelope closure NEVER tears down and reopens the socket.
 *  - Entity maps (`trailers`, `hubs`, `routes`) are imperative Map objects, NOT
 *    React state — so feature mutations bypass the React render path entirely.
 *  - A `seq` gap triggers a `{ v:1, type:"resync" }` client request; the server
 *    responds with a fresh `snapshot` (T-05-14 bounded recovery).
 */
import { useEffect, useRef } from "react";
import type {
  WsEnvelope,
  SnapshotPayload,
  TickPayload,
  TrailerKeyframe,
  HubState,
  RouteState,
} from "@mm/api";

// ---------------------------------------------------------------------------
// Entity maps (pure imperative state, off the React render path)
// ---------------------------------------------------------------------------

/** All entity maps maintained by the ws client. */
export interface EntityMaps {
  readonly trailers: Map<string, TrailerKeyframe>;
  readonly hubs: Map<string, HubState>;
  readonly routes: Map<string, RouteState>;
}

/** Create an empty set of entity maps. */
export function makeEntityMaps(): EntityMaps {
  return {
    trailers: new Map(),
    hubs: new Map(),
    routes: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Pure parsing + application (fully testable in Node — no DOM needed)
// ---------------------------------------------------------------------------

/**
 * Narrow an arbitrary parsed JSON value to a `WsEnvelope`.
 *
 * Returns `null` for unknown versions, unknown types, or missing required
 * fields (T-05-13: malformed envelopes are silently ignored, not applied).
 */
export function parseEnvelope(raw: unknown): WsEnvelope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r["v"] !== 1) return null;
  if (r["type"] !== "snapshot" && r["type"] !== "tick") return null;
  if (typeof r["seq"] !== "number") return null;
  if (typeof r["simMs"] !== "number") return null;
  if (!isSimSpeedState(r["speed"])) return null;
  if (typeof r["payload"] !== "object" || r["payload"] === null) return null;

  return raw as WsEnvelope;
}

/** Validate the envelope-level `speed` field (the SimSpeedState wire contract). */
function isSimSpeedState(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s["multiplier"] === "number" &&
    typeof s["tickIntervalMs"] === "number" &&
    typeof s["simSpeed"] === "number" &&
    typeof s["paused"] === "boolean"
  );
}

/**
 * Replace all entity maps from a `snapshot` payload (full baseline / resync).
 * This REPLACES the maps (not upsert) so stale entities from a prior state are
 * purged — matching the "resync replaces previous maps entirely" invariant.
 */
export function applySnapshot(maps: EntityMaps, payload: SnapshotPayload): void {
  maps.trailers.clear();
  for (const t of payload.trailers) {
    maps.trailers.set(t.id, t);
  }
  maps.hubs.clear();
  for (const h of payload.hubs) {
    maps.hubs.set(h.id, h);
  }
  maps.routes.clear();
  for (const r of payload.routes) {
    maps.routes.set(r.id, r);
  }
}

/**
 * Apply a `tick` delta to the entity maps (upsert + delete, no clear/rebuild).
 *
 * - `trailers`     → upsert by id
 * - `trailersGone` → delete by id
 * - `hubs`         → upsert by id
 * - `routes`       → upsert by id
 */
export function applyTick(maps: EntityMaps, payload: TickPayload): void {
  if (payload.trailers !== undefined) {
    for (const t of payload.trailers) {
      maps.trailers.set(t.id, t);
    }
  }
  if (payload.trailersGone !== undefined) {
    for (const id of payload.trailersGone) {
      maps.trailers.delete(id);
    }
  }
  if (payload.hubs !== undefined) {
    for (const h of payload.hubs) {
      maps.hubs.set(h.id, h);
    }
  }
  if (payload.routes !== undefined) {
    for (const r of payload.routes) {
      maps.routes.set(r.id, r);
    }
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Called for each parsed envelope AFTER entity maps are updated. */
export type EnvelopeHandler = (envelope: WsEnvelope, maps: EntityMaps) => void;

// ---------------------------------------------------------------------------
// React hook: useWsEnvelope
// ---------------------------------------------------------------------------

/** Resolve the same-origin ws URL for the API snapshot channel (`/api/ws`). */
function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/ws`;
}

/**
 * Subscribe to the API ws envelope channel and invoke `onEnvelope` for each
 * parsed + applied message.
 *
 * Realtime discipline:
 *  - Socket opened ONCE per mount; `onEnvelope` stored in a ref so a changing
 *    closure NEVER reopens the socket.
 *  - Snapshot → `applySnapshot` (full replace); Tick → `applyTick` (upsert/delete).
 *  - Seq gap → request fresh snapshot from server (T-05-14).
 *  - All entity map mutations happen off the React render path.
 */
export function useWsEnvelope(
  onEnvelope: EnvelopeHandler,
  maps: EntityMaps,
): void {
  const handlerRef = useRef<EnvelopeHandler>(onEnvelope);
  handlerRef.current = onEnvelope;

  const mapsRef = useRef<EntityMaps>(maps);
  mapsRef.current = maps;

  useEffect(() => {
    let lastSeq = 0;
    const socket = new WebSocket(wsUrl());

    socket.onmessage = (event: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }

      const envelope = parseEnvelope(parsed);
      if (envelope === null) return;

      // Seq-gap detection (T-05-14): if we missed messages, request a resync.
      const currentMaps = mapsRef.current;
      if (lastSeq > 0 && envelope.seq > lastSeq + 1) {
        // Gap detected — request a fresh snapshot.
        try {
          socket.send(JSON.stringify({ v: 1, type: "resync" }));
        } catch {
          // Best-effort; server will re-send snapshot on next connect.
        }
      }
      lastSeq = envelope.seq;

      // Apply the envelope to the local entity maps.
      if (envelope.type === "snapshot") {
        applySnapshot(currentMaps, envelope.payload);
      } else {
        applyTick(currentMaps, envelope.payload);
      }

      handlerRef.current(envelope, currentMaps);
    };

    return () => {
      socket.onmessage = null;
      socket.close();
    };
  }, []);
}
