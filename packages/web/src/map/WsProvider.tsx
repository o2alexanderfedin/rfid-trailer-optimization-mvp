/**
 * WsProvider — single shared WebSocket context (FIX 16).
 *
 * Opens EXACTLY ONE `/api/ws` connection per page and fans out parsed envelopes
 * to all consumers (MapView animation loop, alert feed, KPI dashboard) via a
 * subscriber registry. Previously each consumer opened its own connection,
 * causing three sockets sharing one server seq counter → seq-gap/resync churn.
 *
 * Architecture:
 *  - `WsContext` holds a `SubscriberRegistry` (the shared fanout bus).
 *  - `WsProvider` (React context provider) opens one WebSocket, parses
 *    envelopes, applies entity-map state, and dispatches to all subscribers.
 *  - `useWsEnvelope` reads from `WsContext` (subscribes to the shared bus)
 *    instead of opening its own socket.
 *  - `makeSubscriberRegistry` and `SubscriberRegistry` are exported as pure
 *    helpers for unit testing without a DOM.
 *
 * Seq-gap handling and entity-map updates remain in this module, unchanged from
 * the original `wsClient.ts` hook — they just move to the single provider.
 *
 * Realtime discipline:
 *  - One socket, one seq counter, one entity-map state — shared by all consumers.
 *  - Handler stored in a ref so changing closures never reopen the socket.
 *  - Strict TS: no `any`, no unsafe `as` casts, `noUncheckedIndexedAccess` safe.
 */

import { createContext, useContext, useEffect, useRef } from "react";
import { parseEnvelope, applySnapshot, applyTick, makeEntityMaps } from "./wsClient.js";
import type { WsEnvelope } from "@mm/api";
import type { EntityMaps } from "./wsClient.js";

// ---------------------------------------------------------------------------
// SubscriberRegistry — pure fanout bus (unit-testable without DOM)
// ---------------------------------------------------------------------------

/** A subscriber callback receiving a parsed envelope. */
export type EnvelopeSubscriber = (envelope: WsEnvelope) => void;

/** Unsubscribe function returned by `subscribe()`. */
export type Unsubscribe = () => void;

/** Pure fanout registry — subscribe, unsubscribe, dispatch. */
export interface SubscriberRegistry {
  /** Register a subscriber. Returns an unsubscribe function. */
  subscribe(handler: EnvelopeSubscriber): Unsubscribe;
  /** Dispatch an envelope to all current subscribers. */
  dispatch(envelope: WsEnvelope): void;
  /** Number of active subscribers (for tests). */
  size(): number;
}

/**
 * Create a new subscriber registry.
 *
 * Subscribers are stored in a `Set` — subscribe/unsubscribe are O(1),
 * dispatch is O(n subscribers). Order of dispatch is insertion order.
 */
export function makeSubscriberRegistry(): SubscriberRegistry {
  const subscribers = new Set<EnvelopeSubscriber>();

  return {
    subscribe(handler: EnvelopeSubscriber): Unsubscribe {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },

    dispatch(envelope: WsEnvelope): void {
      for (const handler of subscribers) {
        handler(envelope);
      }
    },

    size(): number {
      return subscribers.size;
    },
  };
}

// ---------------------------------------------------------------------------
// WsContext — shared subscriber registry + entity maps
// ---------------------------------------------------------------------------

/** Value provided by WsContext. */
export interface WsContextValue {
  /** Subscribe to parsed envelopes from the shared socket. */
  readonly registry: SubscriberRegistry;
  /** Shared entity maps (trailers, hubs, routes) — updated before dispatch. */
  readonly maps: EntityMaps;
}

/**
 * React context for the shared WebSocket envelope bus.
 *
 * Default value has a no-op registry + empty maps so consumers don't need
 * a null-check. In production, `WsProvider` wraps the app and provides the
 * real socket-backed instance.
 */
export const WsContext = createContext<WsContextValue>({
  registry: makeSubscriberRegistry(),
  maps: makeEntityMaps(),
});

// ---------------------------------------------------------------------------
// WsProvider — opens ONE socket, dispatches to all subscribers
// ---------------------------------------------------------------------------

interface WsProviderProps {
  readonly children: React.ReactNode;
}

/** Resolve the same-origin ws URL for the API snapshot channel (`/api/ws`). */
function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/ws`;
}

/**
 * WsProvider: open ONE WebSocket and fan out parsed envelopes to all
 * subscribers registered via `useWsEnvelope`.
 *
 * Must wrap the app root (or at minimum any subtree that uses `useWsEnvelope`).
 *
 * Seq-gap detection: a missing seq triggers a `{ v:1, type:"resync" }` request;
 * the server responds with a fresh snapshot.
 */
export function WsProvider({ children }: WsProviderProps): React.JSX.Element {
  // Registry and maps are created once (stable across renders).
  const valueRef = useRef<WsContextValue | null>(null);
  if (valueRef.current === null) {
    valueRef.current = {
      registry: makeSubscriberRegistry(),
      maps: makeEntityMaps(),
    };
  }
  const value = valueRef.current;

  useEffect(() => {
    const { registry, maps } = value;
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
      if (lastSeq > 0 && envelope.seq > lastSeq + 1) {
        try {
          socket.send(JSON.stringify({ v: 1, type: "resync" }));
        } catch {
          // Best-effort; server will re-send snapshot on next connect.
        }
      }
      lastSeq = envelope.seq;

      // Apply to shared entity maps (before dispatch so subscribers see updated state).
      if (envelope.type === "snapshot") {
        applySnapshot(maps, envelope.payload);
      } else {
        applyTick(maps, envelope.payload);
      }

      // Fan out to all subscribers.
      registry.dispatch(envelope);
    };

    return () => {
      socket.onmessage = null;
      socket.close();
    };
    // value is stable (created once in ref above) — no deps needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <WsContext.Provider value={value}>{children}</WsContext.Provider>;
}

// ---------------------------------------------------------------------------
// useWsEnvelope — subscribe to the shared bus (replaces direct socket opening)
// ---------------------------------------------------------------------------

/**
 * Subscribe to parsed ws envelopes from the shared socket opened by `WsProvider`.
 *
 * `onEnvelope` is stored in a ref so a changing closure never re-subscribes.
 * The subscription is removed on unmount.
 *
 * The `maps` parameter is the consumer's own entity-map snapshot — the shared
 * maps from the provider are passed to the handler alongside the envelope.
 * Passing `maps` from the consumer allows different consumers to maintain their
 * own derived state (e.g., MapView has its own TrailerAnim map alongside the
 * shared EntityMaps).
 */
export function useWsEnvelope(
  onEnvelope: (envelope: WsEnvelope, maps: EntityMaps) => void,
  maps: EntityMaps,
): void {
  const ctx = useContext(WsContext);
  const handlerRef = useRef(onEnvelope);
  handlerRef.current = onEnvelope;
  const mapsRef = useRef(maps);
  mapsRef.current = maps;

  useEffect(() => {
    const unsub = ctx.registry.subscribe((envelope) => {
      handlerRef.current(envelope, mapsRef.current);
    });
    return unsub;
  }, [ctx.registry]);
}
