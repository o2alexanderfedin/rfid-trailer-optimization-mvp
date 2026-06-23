/**
 * useLiveSimMs — a LIVE-ticking sim-clock millisecond reading for React panels
 * (Phase 17 / VIZ-08 live elapsed dwell).
 *
 * The map's trailer animation reads sim time from `makeSimClock` inside the OL
 * `postrender` loop (off the React render path). Panels can't hook that loop, so
 * this hook gives them the SAME server-anchored sim time on the React render path:
 *
 *  - It subscribes to the shared ws bus (via `useWsEnvelope`) and resyncs a
 *    private `SimClock` to each envelope's authoritative `simMs` + `speed.simSpeed`
 *    — identical discipline to `MapView.onEnvelope` (resync + setSpeed).
 *  - It re-renders on a fixed wall-clock interval (default 1s) so a consumer's
 *    elapsed dwell (`liveSimMs − arrivedAtMs`) advances on screen between ticks.
 *  - When paused (`simSpeed` 0) the clock holds; the interval still fires but the
 *    value is constant (monotonic by `SimClock` contract), so the dwell freezes —
 *    matching the trailer animation freezing on pause.
 *
 * Returns 0 before the first envelope (no anchor yet). The 1s cadence is plenty
 * for a minutes-granularity dwell counter and keeps React re-renders cheap.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { makeSimClock } from "./simClock.js";
import { useWsEnvelope } from "./WsProvider.js";
import { makeEntityMaps } from "./wsClient.js";
import type { WsEnvelope } from "@mm/api";
import type { EntityMaps } from "./wsClient.js";

/** How often (wall-clock ms) the hook re-renders so the dwell counter ticks. */
const DEFAULT_TICK_MS = 1_000;

/**
 * Live sim-clock milliseconds, anchored to the server and ticking locally.
 *
 * @param tickMs Optional re-render cadence in wall-clock ms (default 1000).
 */
export function useLiveSimMs(tickMs: number = DEFAULT_TICK_MS): number {
  // The private clock lives in a ref (created once) — never on the render path.
  const clockRef = useRef(makeSimClock({ simSpeed: 0 }));
  // A monotonically-increasing nonce forces a re-render each interval/envelope.
  const [, setNonce] = useState(0);
  const bump = useCallback(() => setNonce((n) => n + 1), []);

  // Resync the private clock to each envelope (authoritative simMs + speed),
  // then re-render so the new anchor is reflected immediately.
  const entityMapsRef = useRef<EntityMaps>(makeEntityMaps());
  const onEnvelope = useCallback(
    (envelope: WsEnvelope): void => {
      clockRef.current.setSpeed(envelope.speed.simSpeed);
      clockRef.current.resync(Date.now(), envelope.simMs);
      bump();
    },
    [bump],
  );
  useWsEnvelope(onEnvelope, entityMapsRef.current);

  // Wall-clock interval → re-render so the projected sim time advances on screen.
  useEffect(() => {
    const id = setInterval(bump, tickMs);
    return () => {
      clearInterval(id);
    };
  }, [bump, tickMs]);

  // Read the clock's current projection (0 until the first resync anchors it).
  return clockRef.current.fromFrameTime(Date.now());
}
