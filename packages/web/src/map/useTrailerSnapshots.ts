import { useEffect, useRef } from "react";

/**
 * One trailer's latest known position from a ws snapshot (mirror of the API
 * `TrailerSnapshot` wire shape — kept local so the web package owns its read
 * model and does not import server-only types).
 */
export interface TrailerSnapshot {
  readonly trailerId: string;
  readonly tripId: string;
  readonly kind: string;
  readonly lon: number;
  readonly lat: number;
  readonly t: string;
}

/** The batched per-tick snapshot message pushed over the ws channel. */
export interface SnapshotMessage {
  readonly t: "snapshot";
  readonly trailers: readonly TrailerSnapshot[];
}

/** Called for every parsed snapshot. Kept stable in a ref by the consumer. */
export type SnapshotHandler = (snapshot: SnapshotMessage) => void;

/** Resolve the same-origin ws URL for the API snapshot channel (`/api/ws`). */
function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/ws`;
}

/** Narrow an arbitrary parsed payload to a `SnapshotMessage` (read-side guard). */
function asSnapshot(data: unknown): SnapshotMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const msg = data as { t?: unknown; trailers?: unknown };
  if (msg.t !== "snapshot" || !Array.isArray(msg.trailers)) return null;
  const trailers: TrailerSnapshot[] = [];
  for (const raw of msg.trailers) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (
      typeof r.trailerId === "string" &&
      typeof r.lon === "number" &&
      typeof r.lat === "number"
    ) {
      trailers.push({
        trailerId: r.trailerId,
        tripId: typeof r.tripId === "string" ? r.tripId : "",
        kind: typeof r.kind === "string" ? r.kind : "",
        lon: r.lon,
        lat: r.lat,
        t: typeof r.t === "string" ? r.t : "",
      });
    }
  }
  return { t: "snapshot", trailers };
}

/**
 * Subscribe to the API ws snapshot channel and invoke `onSnapshot` for each
 * parsed `{ t:'snapshot', trailers:[...] }` message.
 *
 * Realtime discipline (validated pattern): the handler is stored in a ref so a
 * changing closure NEVER tears down + reopens the socket, and snapshots flow to
 * the consumer (the OL map) WITHOUT React state — so there is no re-render storm
 * and the map's feature mutation happens off the React render path. The socket
 * is created once and closed on unmount.
 */
export function useTrailerSnapshots(onSnapshot: SnapshotHandler): void {
  const handlerRef = useRef<SnapshotHandler>(onSnapshot);
  handlerRef.current = onSnapshot;

  useEffect(() => {
    const socket = new WebSocket(wsUrl());
    socket.onmessage = (event: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      const snapshot = asSnapshot(parsed);
      if (snapshot !== null) handlerRef.current(snapshot);
    };

    return () => {
      socket.onmessage = null;
      socket.close();
    };
  }, []);
}
