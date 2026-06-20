/**
 * Client-side trailer animation (VIZ-02 / Q2).
 *
 * ONE `postrender` listener on the trailer VectorLayer animates ALL trailers
 * in place using the sim clock and route LineString geometry. This is the
 * canonical OL `feature-move-animation` pattern (05-RESEARCH.md Q2):
 *
 *   trailerLayer.on("postrender", (event) => {
 *     const simNow = simClock.fromFrameTime(event.frameState.time);
 *     for (const t of trailers) {
 *       t.pointGeom.setCoordinates(t.routeGeom.getCoordinateAt(fractionFor(t, simNow)));
 *     }
 *     map.render();
 *   });
 *
 * Leak discipline (P10 / T-01-24):
 *  - NO `new Feature`, `new Point`, `new Style`, or `new LineString` inside the loop.
 *  - `setCoordinates()` mutates the existing geometry IN PLACE.
 *  - `getLength()` is cached per `TrailerAnim` entry (recomputed only on route change).
 *  - `detach()` removes the single listener via `layer.un()`.
 *
 * Resync discipline (Q2):
 *  - A snapshot mid-tween updates `departSimMs`/`etaSimMs`/`routeGeom` IN PLACE
 *    on the existing `TrailerAnim` record (never recreate the Feature).
 *  - The new fraction is derived from the current simNow; position follows
 *    continuously because both old and new keyframes share the same sim clock.
 *  - A same-leg confirming snapshot produces ZERO visual change.
 */
import type VectorLayer from "ol/layer/Vector.js";
import type VectorSource from "ol/source/Vector.js";
import type Map from "ol/Map.js";
import type LineString from "ol/geom/LineString.js";
import type Point from "ol/geom/Point.js";
import type RenderEvent from "ol/render/Event.js";

// ---------------------------------------------------------------------------
// TrailerAnim — per-trailer animation target (mutated in place on resync)
// ---------------------------------------------------------------------------

/**
 * Per-trailer animation target.
 *
 * All fields are mutable so an in-place resync (new snapshot arriving mid-tween)
 * can update timing + route geometry WITHOUT recreating the Feature or Point.
 */
export interface TrailerAnim {
  readonly trailerId: string;
  /**
   * The routeId currently reflected by `routeGeom`.
   * Used to detect route changes so the LineString + length are only rebuilt
   * when the trailer switches legs (FIX 15 — per-frame LineString allocation).
   */
  currentRouteId: string;
  /** Shared LineString reference from the routes source (NOT cloned per frame). */
  routeGeom: LineString;
  /** `routeGeom.getLength()` cached; recompute only when routeGeom changes. */
  routeLengthM: number;
  /** Sim-clock ms at leg start (depart). */
  departSimMs: number;
  /** Sim-clock ms at leg end (ETA). */
  etaSimMs: number;
  /** The feature geometry mutated in place per frame (Tactic A). */
  readonly pointGeom: Point;
}

// ---------------------------------------------------------------------------
// fractionFor: the core tween math (pure, testable in Node)
// ---------------------------------------------------------------------------

/**
 * Compute the interpolation fraction for a trailer at `simNowMs`.
 *
 * fraction = clamp((simNow - departMs) / (etaMs - departMs), 0, 1)
 *
 *  - Returns 0 before departure (trailer at route start).
 *  - Returns 1 after ETA (trailer at route end).
 *  - Returns 1 for a zero-span leg (departMs === etaMs).
 *  - Never extrapolates outside [0, 1] (per Q2 — clamp, not project).
 */
export function fractionFor(t: TrailerAnim, simNowMs: number): number {
  const span = t.etaSimMs - t.departSimMs;
  if (span <= 0) return 1;
  const raw = (simNowMs - t.departSimMs) / span;
  return raw < 0 ? 0 : raw > 1 ? 1 : raw;
}

// ---------------------------------------------------------------------------
// attachTrailerAnimation
// ---------------------------------------------------------------------------

/** Return value of `attachTrailerAnimation` — provides `detach()` for teardown. */
export interface TrailerAnimationHandle {
  /** Remove the `postrender` listener (call on map teardown or layer removal). */
  detach(): void;
}

/**
 * Attach ONE `postrender` listener to `layer` that animates all trailers in
 * `trailers` each frame using the shared sim clock.
 *
 * The returned `detach()` must be called on teardown to avoid a listener leak.
 *
 * @param layer    The trailer VectorLayer to attach to.
 * @param map      The OL Map (used for `map.render()` to schedule next frame).
 * @param trailers Live map of trailerId → TrailerAnim (mutated in place by ws client).
 * @param getSimNow Optional sim-now getter; defaults to using `frameState.time` directly
 *                  (simSpeed=1). Pass `simClock.fromFrameTime` when using a real sim clock.
 */
export function attachTrailerAnimation(
  layer: VectorLayer<VectorSource>,
  map: Map,
  trailers: ReadonlyMap<string, TrailerAnim>,
  getSimNow?: (frameTime: number) => number,
): TrailerAnimationHandle {
  const simNowFn = getSimNow ?? ((t: number) => t);

  // ONE listener for ALL trailers — never per-trailer timers/intervals.
  const handler = (event: RenderEvent): void => {
    const frameState = event.frameState;
    if (frameState === undefined || frameState === null) return;
    const simNow = simNowFn(frameState.time);

    for (const t of trailers.values()) {
      const f = fractionFor(t, simNow);
      // In-place mutation — NO new Feature/Point/Style/LineString here.
      const coord = t.routeGeom.getCoordinateAt(f);
      t.pointGeom.setCoordinates(coord);
    }

    // Schedule the next frame — keeps the loop alive while the map is visible.
    map.render();
  };

  // Cast: OL's layer.on("postrender") is overloaded and TS doesn't unify the
  // overload for the string literal form when the handler type is RenderEvent.
  // Using the type-safe overloaded form directly:
  const listenerKey = layer.on(
    "postrender",
    handler as (event: RenderEvent) => void,
  );

  return {
    detach(): void {
      layer.un("postrender", handler as (event: RenderEvent) => void);
      void listenerKey; // suppress unused-var warning; un() uses the function ref
    },
  };
}
