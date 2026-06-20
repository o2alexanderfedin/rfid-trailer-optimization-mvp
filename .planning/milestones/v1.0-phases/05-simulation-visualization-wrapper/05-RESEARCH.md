# Phase 5 Research: Simulation + Visualization Wrapper

**Phase:** 05 — Simulation + Visualization Wrapper
**Requirements:** SIM-04, VIZ-02, VIZ-03, VIZ-04, VIZ-05, UI-01, UI-02, UI-03, UI-04
**Researched:** 2026-06-19
**Stack (fixed):** TypeScript + React 19 + Vite 7 + OpenLayers (`ol`) `10.9.0` + OSM tiles; backend Fastify + native `ws`; event-sourced Postgres twin.
**Confidence:** HIGH on the OpenLayers rendering/animation API (verified against official `ol` 10 docs + the canonical `feature-move-animation` example); HIGH on the ws-protocol shape (industry keyframe+delta consensus); MEDIUM-HIGH on exact performance thresholds (synthesized, not benchmarked on this hardware).

> **Sources consulted via Google AI Mode** (`https://www.google.com/search?udm=50&q=…`) — **reachable**, AI panel rendered for all five questions, no consent/captcha wall. Each AI answer was cross-checked against the authoritative `ol` docs/examples it cited (via WebFetch) before being adopted. Where the AI answer and the official docs/this codebase differ, **the docs/codebase win** (noted inline).

---

## Baseline this phase extends (read first)

Phase 1 already stood up the centerpiece slice — do **not** rebuild it; extend it.

- `packages/web/src/map/MapView.tsx` — `ol/Map` created **exactly once** in a `useRef`, disposed on unmount; ws snapshots applied off the React render path. Has `data-*` diagnostic attributes the Playwright leak guard reads.
- `packages/web/src/map/layers.ts` — three single-source layers (hubs/routes/trailers), each with **one shared `Style` instance**; `updateTrailerFeatures()` mutates `Point.setCoordinates()` **in place** (never rebuilds the source).
- `packages/web/src/map/useTrailerSnapshots.ts` — single `WebSocket`, handler in a ref so a changing closure never reopens the socket; parses `{ t:'snapshot', trailers:[…] }`.
- `packages/api/src/ws/snapshots.ts` — broadcasts **one batched snapshot per sim tick** (never per raw event). Today each trailer carries only its **latest keyframe** (`depart`/`arrive`, with `lon/lat/t/kind/tripId`).
- `packages/projections/src/reducers/geo-track.ts` — emits `depart` (route origin, first LineString vertex) + `arrive` (route destination, last vertex) keyframes per trip; positions come from the logged `RouteRegistered.geometry`, time from `occurredAt` (deterministic, P3-safe).
- `packages/web/test/leak.e2e.ts` — the existing leak guard: across 40 ws snapshots, `data-trailer-count` stays == fleet size, `data-map-instances == 1`, `data-trailer-source-instances == 1`, and `data-trailer-uid` is unchanged (proves in-place mutation).

**Phase-5 gap vs baseline:** the current map *teleports* trailers to the latest keyframe each snapshot — no client-side tween yet, no full route geometry on the client, no coloring, no exception/KPI/plan diffs. This phase adds: (a) smooth interpolation along the **route LineString**, (b) state-driven coloring, (c) an expanded typed ws envelope carrying keyframes + hub/route metrics + exception/KPI/plan deltas, while preserving every leak invariant.

---

## Q1 — High-trailer-count animation (VIZ-02): WebGL vs Vector + postrender

### RECOMMENDATION

**Use a `VectorLayer` driven by the Immediate Rendering API (`postrender` + `getVectorContext`) — OR equivalently the existing single-source `VectorLayer` with in-place `Point.setCoordinates()` — as the ONE primary approach for this MVP.** Do **not** introduce a `WebGLPointsLayer`/`WebGLVectorLayer` for Phase 5.

**Rationale (demo scale is modest):** the spec's pilot scale is "20–50 trailers" (PITFALLS P8, spec §23); even a stretch national demo is tens–low-hundreds of moving trailers. Google AI Mode's synthesized threshold (cross-checked against the OL immediate-rendering example + OL issue #5054):

| Moving point count | Winner | Why |
|---|---|---|
| **100 – ~2,000** (our range) | **`VectorLayer` + `postrender` / in-place feature mutation** | Canvas-2D mutation beats CPU→GPU per-frame coordinate uploads at 60 FPS; zero per-frame feature/style allocation; zero GC flares. |
| **2,000+** | `WebGLPointsLayer` | Canvas-2D `drawGeometry` draw-call count becomes the main-thread CPU bottleneck; WebGL's batched GPU draw wins despite data-transfer lag. |

The vector approach degrades only when JS `drawGeometry` calls (or feature-change events) saturate the main thread — reported around **5,000+** points (OL #5054). We are an order of magnitude below that.

**Why not WebGL now:** WebGL layers in OL trade per-frame CPU cost for a per-frame GPU upload cost and a much stiffer styling model (the expression-based `WebGLPointsLayer` style language, not arbitrary `Style`), which would force a rewrite of the data-driven coloring in Q4 and complicate disposal. For a demo at our scale it is strictly more code for negative benefit.

### Two valid vector tactics (pick ONE; keep the simpler unless profiling forces the switch)

**Tactic A (lowest-risk, extends the current code): keep real `ol/Feature`s, mutate geometry in place per animation frame.**
This is what `layers.ts::updateTrailerFeatures` already does for snapshots; Phase 5 just moves the `setCoordinates` call into a per-frame interpolation loop instead of per-snapshot. Preserves the existing leak guard verbatim (feature count bounded, uid stable).

```ts
// Per animation frame (driven by the map render loop — see Q2):
const coord = interpolateAlongRoute(trailer, simNow); // route.getCoordinateAt(clampedFraction)
trailer.pointGeom.setCoordinates(coord);              // in-place; NO new Feature, NO source rebuild
```

**Tactic B (canonical OL animation, lowest GC): draw raw geometries with the Immediate API inside `postrender`.**
Bypasses the `propertychange → feature → source → layer → map` event chain entirely; you draw lightweight `Point`/coordinate arrays straight onto the active 2D canvas. This is the OL `feature-move-animation` pattern (verified).

```ts
import { getVectorContext } from "ol/render.js";
import { Style, Icon } from "ol/style.js";

const trailerStyle = new Style({ image: new Icon({ /* … */ }) }); // ONE shared style
trailerLayer.on("postrender", (event) => {
  const ctx = getVectorContext(event);
  ctx.setStyle(trailerStyle);
  for (const t of trailers) {            // a few hundred raw Point geoms
    ctx.drawGeometry(t.pointGeom);       // no feature/style allocation this frame
  }
  map.render();                          // schedule the next frame
});
```

> **Decision:** start with **Tactic A** (smallest delta from the shipped, leak-guarded code; click-to-select a trailer in UI-02 is trivial because features still exist for hit-testing). Reserve Tactic B if profiling shows feature-event overhead at the high end. The scale-up path beyond ~2,000 is a `WebGLPointsLayer` swap behind the same snapshot/interpolation interface — out of scope for this MVP but kept open.

**Citations (Q1):**
- Google AI Mode — threshold + trade-off synthesis (reachable). Cited: OL immediate-rendering example `https://openlayers.org/en/latest/examples/immediate-geographic.html`; `VectorContext` apidoc `https://openlayers.org/en/latest/apidoc/module-ol_render_VectorContext-VectorContext.html`; OL #5054 draw-call bottleneck `https://github.com/openlayers/openlayers/issues/5054`.
- PITFALLS.md P10 + Performance Traps ("WebGL points layer for many trailers", "in-place geometry updates"); ROADMAP Phase 5 Notes.

---

## Q2 — Smooth client-side interpolation (sim-clock-driven, along the route, resync-safe)

### RECOMMENDATION

**Drive interpolation from the OpenLayers `postrender` event using `frameState.time` (NOT a bare `requestAnimationFrame` loop), compute a per-trailer fraction from the SIM CLOCK clamped to `[0,1]`, and position via `LineString.getCoordinateAt(fraction)` so motion follows the route geometry (never straight-line). Call `map.render()` each frame to keep the loop alive. On a new snapshot, update the keyframe targets in place and re-derive the fraction from current sim time — never reset position to a vertex mid-leg (that causes the jitter/teleport).**

This is the canonical OL pattern, **verified** against the official `feature-move-animation` example (which uses exactly `vectorLayer.on('postrender', …)`, `frameState.time`, `route.getCoordinateAt(distance)`, and `map.render()`).

### Why `postrender` over raw rAF (Google AI Mode, confirmed by the OL example design)

- **Map synchronization:** `postrender` fires when the map canvas actually updates; a bare rAF loop runs on the browser's refresh clock, so during a user pan/zoom the moving point visibly **drifts/lags** behind the basemap. `postrender` locks the point to the same frame as the tiles.
- **Frame-rate decoupling:** `frameState.time` is the true hardware timestamp, so if rendering drops frames the interpolation pace stays accurate (it's time-based, not frame-counted).
- **One loop, not N timers:** a single `postrender` listener animates all trailers — avoids the PITFALLS "many trailers each with their own `setInterval`" leak trap.

### The keyframe model (matches the server today)

Server pushes, per trailer, the **leg it is on**: `routeId` (→ the LineString already on the client from `/api/routes`), `departSimTime`, `etaSimTime`, plus a `legProgress` baseline if mid-leg on first send. The client tweens between `depart` and `eta`. The geo-track projection already emits depart/arrive keyframes from logged route geometry (P3-deterministic) — Phase 5 adds the **ETA** (from the trip/plan) so the client knows the leg's time span.

### Canonical pattern (sim-clock, clamped, along route, resync-safe)

```ts
import { getVectorContext } from "ol/render.js";

/** Per-trailer animation target, updated in place by each ws snapshot. */
interface TrailerAnim {
  readonly trailerId: string;
  routeGeom: LineString;     // shared reference from the routes source (NOT cloned per frame)
  routeLengthM: number;      // routeGeom.getLength() — cache; recompute only on route change
  departSimMs: number;       // sim-clock ms at leg start
  etaSimMs: number;          // sim-clock ms at leg end (ETA)
  pointGeom: Point;          // the feature geometry we mutate in place (Tactic A)
}

/** Sim clock: monotonic mapping wall→sim. Driven by snapshot `serverSimMs` + a local rate. */
const simClock = makeSimClock(); // simClock.now() returns sim-time ms; resynced on each snapshot

function fractionFor(t: TrailerAnim, simNowMs: number): number {
  const span = t.etaSimMs - t.departSimMs;
  if (span <= 0) return 1;
  const f = (simNowMs - t.departSimMs) / span;
  return f < 0 ? 0 : f > 1 ? 1 : f;          // CLAMP to [0,1] — never extrapolate past the leg
}

// ONE listener animates every trailer, tied to the map's render clock:
trailerLayer.on("postrender", (event) => {
  const simNow = simClock.fromFrameTime(event.frameState.time); // sim-clock, NOT Date.now()
  for (const t of trailers.values()) {
    const f = fractionFor(t, simNow);
    const coord = t.routeGeom.getCoordinateAt(f); // follows the LineString, not a straight line
    t.pointGeom.setCoordinates(coord);            // in-place mutation
  }
  map.render(); // schedule the next frame
});
```

`LineString.getCoordinateAt(fraction, dest?)` is **verified** in the OL 10 apidoc: "Return the coordinate at the provided fraction along the linestring. The fraction is a number between 0 and 1, where 0 is the start … and 1 is the end." `getLength()` is also confirmed (cache it; only recompute when the route geometry changes).

### Resync without jitter (the part most implementations get wrong)

When a new snapshot arrives mid-tween, **do not** snap the point back to a vertex (Google AI Mode's naive "Option A: reset startTime to 0" causes a visible jump). Instead:

1. Update `departSimMs`/`etaSimMs`/`routeGeom` on the existing `TrailerAnim` **in place** (mutate the record; do not recreate features).
2. Resync the **sim clock** to the snapshot's authoritative `serverSimMs` with a small smoothing (clamp the correction so the clock nudges, doesn't lurch).
3. Let the next `postrender` recompute the fraction from sim time — position follows continuously because both old and new keyframes are anchored to the same sim clock.
4. **If the leg actually changed** (new `routeId`): bridge the discontinuity by seeding the new leg's fraction from `routeGeom.getClosestPoint(currentCoord)` (Google AI Mode "Option B") so the visual position is continuous across the leg boundary, then resume time-based interpolation.

Anchoring both endpoints to a shared sim clock is what makes the tween idempotent on resync: a snapshot that merely confirms the current leg produces **zero** visual change.

**Citations (Q2):**
- Official OL `feature-move-animation` example (verified via WebFetch): uses `postrender`, `frameState.time`, `route.getCoordinateAt(...)`, `map.render()` — `https://openlayers.org/en/latest/examples/feature-move-animation.html`.
- OL `LineString.getCoordinateAt` / `getLength` apidoc (verified): `https://openlayers.org/en/latest/apidoc/module-ol_geom_LineString-LineString.html`.
- Google AI Mode — `postrender` vs rAF rationale + resync options (reachable); cross-checked above.
- PITFALLS.md Performance Traps ("interpolate between last two known points using event timestamps, clamp to [0,1], drive from a single rAF loop tied to a sim clock") and the "Sim clock" looks-done-but-isn't item.

---

## Q3 — ws state-diff protocol shape (per-tick, no per-event spam)

### RECOMMENDATION

**Extend the existing single per-tick message into a versioned, typed envelope carrying a `snapshot` (full baseline, sent on connect/resync) and a `tick` (delta of what changed this tick). Keep JSON with short keys. One message per sim tick (or on a meaningful event), never one per raw domain event. The client tweens positions and applies metric/exception/plan deltas to local state.** This is the **keyframe + delta** model (Google AI Mode's "industry best practice," consistent with the codebase's existing "one batched snapshot per tick, client tweens" rule).

### Why this shape

- **No per-event spam:** PITFALLS Integration Gotchas + ARCHITECTURE Anti-Pattern 4 + threat T-01-19 all forbid pushing every domain event to the browser. The server already collapses to one message/tick; Phase 5 keeps that and *widens the payload*, it does not raise the frequency.
- **Keyframe vs delta:** a full `snapshot` lets a freshly-connected or desynced client paint immediately (the server does this on connect today). Thereafter `tick` carries only changed fields keyed by entity id, so bandwidth scales with *change*, not fleet size.
- **Client lags by a small interpolation window** (Google AI Mode: ~2–3 ticks, 100–150 ms) and tweens between the last two known keyframes; on a dropped tick, hold the last leg (the fraction clamps at 1) rather than dead-reckon off-route (we have route geometry, so we never need straight-line extrapolation).

### Concrete typed envelope (TypeScript)

```ts
/** Wire envelope. `v` = protocol version (P11-style evolution guard). */
type WsEnvelope =
  | { v: 1; type: "snapshot"; seq: number; simMs: number; payload: SnapshotPayload }
  | { v: 1; type: "tick";     seq: number; simMs: number; payload: TickPayload };

/** Full baseline — on connect and on client-requested resync. */
interface SnapshotPayload {
  trailers: TrailerKeyframe[];   // every trailer's current leg + timing
  hubs: HubState[];              // VIZ-03 hub metrics
  routes: RouteState[];          // VIZ-03 route/edge metrics
  kpis: KpiSnapshot;             // UI-03 dashboard baseline (incl. baseline-vs-optimizer)
  exceptionsOpen: ExceptionItem[]; // VIZ-04/UI-01 currently-open exceptions
}

/** Per-tick delta — only what changed since the prior tick. */
interface TickPayload {
  trailers?: TrailerKeyframe[];  // upsert: trailers whose leg/timing/state changed this tick
  trailersGone?: string[];       // trailerIds that completed/left the network
  hubs?: HubState[];             // hubs whose metric bucket changed
  routes?: RouteState[];         // routes whose metric bucket changed
  kpis?: Partial<KpiSnapshot>;   // changed KPI fields (UI-03/UI-04 deltas)
  exceptionsNew?: ExceptionItem[];   // VIZ-04/UI-01 new exceptions this tick
  exceptionsResolved?: string[];     // exception ids cleared
  planChanges?: PlanDelta[];     // UI-04 plan deltas (re-optimization made visible)
}

/** VIZ-02 — drives the tween; NO per-second position, just the leg + its time span. */
interface TrailerKeyframe {
  id: string;                    // trailerId
  routeId: string;               // → the LineString already on the client
  departMs: number;              // sim-clock ms at leg start
  etaMs: number;                 // sim-clock ms at leg end
  state: TrailerStateBucket;     // coloring driver: "onTime" | "slaRisk" | "late" | "idle"
  util?: number;                 // 0..1 fill — optional, only when it changes (UI-02 hint)
}

interface HubState {             // VIZ-03
  id: string;
  volumeBucket: number;          // 0..N pre-bucketed (integer; P3 — no float keys)
  slaRiskBucket: number;
  congestionBucket: number;
}

interface RouteState {           // VIZ-03 (edge coloring)
  id: string;
  loadBucket: number;
  slaRiskBucket: number;
}

interface ExceptionItem {        // VIZ-04 / UI-01
  id: string;
  kind: "wrongTrailer" | "missedUnload" | "blockedFreight" | "lowUtilization";
  severity: "low" | "med" | "high";
  entityId: string;              // trailer/hub/package the badge attaches to
  reason: string;                // plain-English
  recommendedAction: string;
  simMs: number;
}

interface PlanDelta {            // UI-04
  trailerId: string;
  changeKind: "split" | "reassign" | "hold" | "overCarry" | "resequence";
  rationale: string;
}

interface KpiSnapshot {          // UI-03 / VIZ-05 "money slide"
  utilization: number;
  rehandleCount: number;
  rehandleMinutes: number;
  wrongTrailerCount: number;
  missedUnloadCount: number;
  slaViolationRate: number;
  onTimeDeparture: number;
  onTimeArrival: number;
  // before/after — same field set under the baseline planner on the SAME seed:
  baseline: Omit<KpiSnapshot, "baseline">;
}
```

### Design notes
- **`seq` + `simMs`** on every message: `seq` detects drops/reorder (resync trigger → client asks for a fresh `snapshot`); `simMs` is the authoritative sim clock the client resyncs its local clock against (Q2).
- **Buckets, not raw floats** for coloring metrics — keeps the wire small, makes the client style lookup O(1) by index (Q4), and is P3-friendly (integer keys, no float-key sort/group nondeterminism).
- **Versioned (`v`)** so the envelope can evolve without breaking older clients (mirrors the event `schemaVersion` discipline, P11).
- **Backward-compatible migration:** the current `{ t:'snapshot', trailers, hubs }` becomes the `type:"snapshot"` baseline; existing `useTrailerSnapshots.asSnapshot` narrowing extends to the new union. Keep `lon/lat` off the wire for moving trailers (client derives position from `routeId`+fraction), but keep them for the initial paint fallback if a route isn't loaded yet.
- **Binary/Protobuf and viewport interest-management** (Google AI Mode's >500-entity tips) are explicitly **out of scope** for this MVP scale — note them as the scale-up path only.

**Citations (Q3):**
- Google AI Mode — keyframe+delta protocol, short-key envelope, `v`/`seq`/`ts`/`type`/`payload`, upsert/delete, client interpolation buffer, dead-reckoning, Protobuf/interest-management as scale-up (reachable). Cited "Designing a Real-Time Order Tracking System" (Medium) on interpolation.
- Codebase: `packages/api/src/ws/snapshots.ts` (one batched message/tick), ARCHITECTURE Anti-Pattern 4 / threat T-01-19.

---

## Q4 — State-driven coloring (VIZ-03): data-driven StyleFunction + legend

### RECOMMENDATION

**Pre-allocate a `STYLE_CACHE: Style[]` (one `Style` per color-ramp bucket) at module load, and use a `StyleFunction` that maps a feature's metric bucket to a cached `Style` reference — returning the SAME object every frame, allocating nothing per render. Build the HTML legend from the same `COLORS`/`BUCKETS` arrays so the ramp is a single source of truth.** This satisfies VIZ-03 ("colored by freight volume / SLA risk / congestion") without violating the P10 "no per-feature style allocation per frame" rule the existing `layers.ts` already honors.

This is exactly the AI Mode pattern, and it generalizes the codebase's current "one shared `Style` per layer" to "one shared `Style` per *bucket*."

### Pattern (cached styles keyed by bucket)

```ts
import { Style, Fill, Stroke, Circle as CircleStyle } from "ol/style.js";

// Color ramp + integer bucket bounds — the SINGLE source of truth (ramp + legend).
const HUB_COLORS = ["#2dc937", "#99c140", "#e7b416", "#db7b2b", "#cc3232"]; // green→red
const HUB_BUCKET_LABELS = ["very low", "low", "moderate", "high", "critical"];

// Pre-allocate ONE Style per bucket — zero per-frame allocation.
const HUB_STYLE_CACHE: Style[] = HUB_COLORS.map(
  (color) =>
    new Style({
      image: new CircleStyle({
        radius: 8,
        fill: new Fill({ color }),
        stroke: new Stroke({ color: "#ffffff", width: 2 }),
      }),
    }),
);
const HUB_STYLE_DEFAULT = new Style({
  image: new CircleStyle({ radius: 8, fill: new Fill({ color: "#9aa0a6" }) }),
});

/** Zero-allocation StyleFunction: bucket already integer (from the ws metric). */
function hubStyle(feature: FeatureLike): Style {
  const b = feature.get("volumeBucket"); // pre-bucketed on the server (Q3)
  return typeof b === "number" && b >= 0 && b < HUB_STYLE_CACHE.length
    ? HUB_STYLE_CACHE[b]            // shared reference — NOTHING allocated this frame
    : HUB_STYLE_DEFAULT;
}

new VectorLayer({ source: hubSource, style: hubStyle });
```

### Updating in place (no source rebuild)
The ws `HubState`/`RouteState` deltas (Q3) carry the new bucket. Apply by `feature.set("volumeBucket", b)` on the existing feature — OL re-invokes the `StyleFunction`, which returns the (already-allocated) bucket style. **Never** `source.clear()`/rebuild and **never** `feature.setStyle(new Style(...))` per tick. To switch the *active* metric (volume ↔ SLA-risk ↔ congestion) for VIZ-03, swap which cache the `StyleFunction` reads (a tiny module-level `activeMetric` ref + `layer.changed()`), not the features.

### Legend (same arrays = single source of truth)

```tsx
function HubLegend({ activeMetric }: { activeMetric: string }) {
  return (
    <div className="legend">
      <h4>{activeMetric}</h4>
      {HUB_COLORS.map((color, i) => (
        <div className="legend__row" key={i}>
          <span className="legend__swatch" style={{ background: color }} />
          <span>{HUB_BUCKET_LABELS[i]}</span>
        </div>
      ))}
    </div>
  );
}
```

> **Trade-off:** server-side bucketing (chosen) keeps the wire tiny, the client O(1), and avoids float-key nondeterminism — at the cost of fixed bucket boundaries. That's the right call for a demo with calibrated scenarios. If continuous ramps are ever wanted, compute buckets client-side from raw values, but still snap to a fixed N-entry `STYLE_CACHE` (never allocate per feature).

**Citations (Q4):**
- Google AI Mode — `STYLE_CACHE` keyed by bucket index, zero-GC StyleFunction, legend from shared `COLORS`/`BUCKETS` (reachable).
- Codebase `packages/web/src/map/layers.ts` (existing "one shared `Style` instance per layer" discipline this extends).
- OL StyleFunction contract: `https://openlayers.org/en/latest/apidoc/module-ol_style_Style.html` (a `StyleFunction` returns `Style | Style[]`; returning a cached instance is supported).

---

## Q5 — Leak/perf discipline (PITFALLS P10): in-place mutation, disposal, flat-memory verification

### RECOMMENDATION

**Keep every Phase-1 leak invariant (single source, in-place geometry mutation, map created once, strict disposal on teardown) and add a multi-minute headed-Playwright soak test that asserts `performance.memory.usedJSHeapSize` is flat after a forced GC.** Coloring and interpolation must allocate nothing per frame (Q2/Q4 guarantee this).

### In-place mutation rules (already partly in place — extend, don't regress)
- **Reuse geometry objects:** instantiate each trailer's `Point` once; per frame call `pointGeom.setCoordinates(coord)` (Tactic A) or draw raw geoms via `getVectorContext` (Tactic B). Never `new Feature`/`new Point`/`new Style` inside the render or snapshot loop.
- **Never rebuild the source per frame/tick:** no `source.clear()` + re-add on update; upsert by feature id (the current `updateTrailerFeatures` pattern) and mutate. Bucket/metric changes are `feature.set(prop, value)`, not new styles.
- **Cache `getLength()`** per route; recompute only when a route geometry changes (rare).
- **One animation loop:** a single `postrender` listener for all trailers — no per-trailer `setInterval`/rAF (a documented leak trap, PITFALLS).

### Strict disposal checklist (on unmount / teardown) — superset of what `MapView.tsx` does today
1. **Cancel the loop:** `layer.un('postrender', handler)` / clear any `unByKey` listener keys; abort in-flight fetches (`AbortController`, already present).
2. **Close the ws** (already done in `useTrailerSnapshots`).
3. **Clear every vector source:** `source.clear()` for hubs/routes/trailers (already done in the teardown loop).
4. **Detach the map:** `map.setTarget(undefined)` then `map.dispose()` (already done).
5. **Null the refs:** `mapRef.current = null`, source refs `= null` (already done) — lets GC reclaim.
6. **Remove overlays** (popups for UI-02 click-to-inspect): `map.removeOverlay(overlay)` before nulling — **new** for Phase 5 (UI-02 introduces overlays).
7. Under React StrictMode the effect runs mount→cleanup→remount; the existing `data-map-net-live` (created − disposed) invariant must stay `1` — keep it.

### Verifying flat memory over a multi-minute run (concrete)
Extend the existing `packages/web/test/leak.e2e.ts` harness (it already stubs `/api/hubs`, `/api/routes`, and `routeWebSocket`):

```ts
// Headed soak: stream snapshots for ~2–3 min, force GC, assert heap is flat.
test("flat heap over a multi-minute animated run", async ({ page }) => {
  // … existing route stubs + a ws stub that pushes a `tick` every ~250ms with
  //    moving trailers + churning hub/route buckets + occasional exceptions …
  await page.goto("/");

  const heap = () =>
    page.evaluate(() => (performance as any).memory?.usedJSHeapSize ?? 0);

  // Warm up, force GC (requires --js-flags=--expose-gc), take a baseline.
  await page.waitForTimeout(10_000);
  await page.evaluate(() => (globalThis as any).gc?.());
  const before = await heap();

  await page.waitForTimeout(150_000); // ~2.5 min of animation + ticks
  await page.evaluate(() => (globalThis as any).gc?.());
  const after = await heap();

  // Bounded growth only (allow modest noise; NO monotonic climb).
  expect(after - before).toBeLessThan(before * 0.25);

  // The structural invariants must still hold after the soak:
  const mapEl = page.getByTestId("map");
  await expect(mapEl).toHaveAttribute("data-map-instances", "1");
  await expect(mapEl).toHaveAttribute("data-trailer-source-instances", "1");
  // feature count == fleet size (bounded, never grows per tick):
  // … assert data-trailer-count == fleet …
});
```

**Setup notes (verified pattern from AI Mode + DevTools docs):**
- `performance.memory` is Chromium-only and coarse; launch Chromium with `--enable-precise-memory-info` and `--js-flags=--expose-gc` (Playwright `launchOptions.args`) so `usedJSHeapSize` is precise and `globalThis.gc()` is callable to force collection before each measurement (otherwise lazy GC masks/false-flags leaks).
- The signal that matters is **stabilization after forced GC**, not the instantaneous value — heap that keeps climbing across GCs is the leak; heap that returns to ~baseline after GC is healthy.
- For a deeper one-off audit (CI-optional), the Chrome DevTools **heap-snapshot comparison** (baseline → interact → GC → second snapshot → diff) is the gold standard — look for lingering `ol/Map`, `ol/layer/Vector`, `ol/source/Vector`, and **detached `ol/Feature`** instances. This is manual/occasional, not the per-CI gate; the `performance.memory` soak above is the automated gate.

### Phase-5 leak checklist (gate before VIZ-02 ships)
- [ ] `new Feature`/`new Point`/`new Style`/`new LineString` count is **zero** inside any `postrender`/snapshot handler (grep the render path).
- [ ] One `postrender` listener total for trailer animation; removed on teardown.
- [ ] `STYLE_CACHE` length is fixed; `StyleFunction` returns cached references only (Q4).
- [ ] `getLength()` cached per route; route geom not cloned per frame.
- [ ] UI-02 overlays removed (`map.removeOverlay`) on teardown.
- [ ] `data-map-net-live == 1`, `data-map-instances == 1`, `data-trailer-source-instances == 1` after the soak.
- [ ] `usedJSHeapSize` flat (returns to ~baseline) after forced GC across a ~2–3 min run.
- [ ] `data-trailer-count == fleet size` throughout (no per-tick source growth).

**Citations (Q5):**
- Google AI Mode — disposal checklist (unbind → clear → dispose → null target → null ref), `--enable-precise-memory-info`, `usedJSHeapSize` stabilization-after-GC, in-place `setCoordinates` good/bad example, heap-snapshot comparison (reachable). Cited DebugBear / DEV / Medium MemLab on heap profiling.
- PITFALLS.md P10, Integration Gotchas ("OL layer/map lifecycle … on teardown: clear sources, dispose renderers, set source null, remove layers, set map null"), Performance Traps; verified OL leak issues #8141/#10437/#7954.
- Codebase `packages/web/src/map/MapView.tsx` teardown + `packages/web/test/leak.e2e.ts` (the harness to extend).

---

## Cross-cutting: how this serves the rest of Phase 5 (UI-02/VIZ-04/UI-01/UI-03/UI-04/VIZ-05)

- **UI-02 (click trailer → load plan + why):** Tactic A keeps real features, so `map.forEachFeatureAtPixel` hit-testing works directly; on click, fetch the trailer's plan (`POST /plan` outputs from Phase 2: rear→nose order, instructions, per-placement rationale) and show in an `ol/Overlay` popup or a side panel (dispose the overlay on teardown — Q5 item 6).
- **VIZ-04 / UI-01 (exception feed):** driven by `exceptionsNew`/`exceptionsResolved` in the `tick` (Q3) — append to a React list (this is normal React state, *off* the map render path) and optionally pulse a colored badge on the affected map feature via a bucket bump (Q4). Confidence-thresholded server-side (P6) so the feed isn't flooded.
- **UI-03 / VIZ-05 (KPI dashboard + "money slide"):** `KpiSnapshot.baseline` vs live fields (Q3) render as React components; the baseline planner already shares KPI plumbing (Phase 2, P8), so this is wiring. Animate KPI deltas on change (PITFALLS UX: "numbers must visibly move").
- **UI-04 (plan deltas / re-optimization visible):** `planChanges` in the `tick` → toast/animate the affected trailer's color + a "why" rationale, making Phase-4 re-optimization legible on the map.
- **SIM-04 (scenario knobs):** knob changes are *commands to the server* (a separate `POST` or a client→server ws `command` message), NOT new map plumbing — they alter the sim, which flows back through the same `tick` stream.

---

## Open questions for discuss-phase

1. **Tactic A vs B for VIZ-02:** confirm we start with **Tactic A** (real features, in-place mutation — smallest delta, free hit-testing for UI-02). Switch to Tactic B (immediate API) only if a soak shows feature-event overhead. Agree on the trigger to switch.
2. **ETA source for the tween:** the geo-track projection emits depart/arrive keyframes but not ETA. Does ETA come from the Phase-4 trip plan, a sim-scheduled arrival event, or great-circle time estimate? The tween's `etaMs` (Q2) needs an authoritative source — and it must be **deterministic** (P3) for replay.
3. **Sim-clock authority + rate:** server `simMs` per tick is the anchor — what's the demo's sim-time:wall-time ratio (e.g., 1 sim-hour : 1 wall-second)? How aggressively does the client smooth clock corrections on resync (nudge size) to stay jitter-free?
4. **Bucket boundaries for VIZ-03:** who owns the volume/SLA-risk/congestion bucket thresholds, and how many buckets (ramp size)? Fixed per scenario, or derived from the calibrated seed? (Affects `STYLE_CACHE` size and legend.)
5. **Snapshot vs tick cadence & resync trigger:** confirm tick = sim tick (~250 ms–1 s); how often (if ever) to send a full `snapshot` beyond connect (e.g., every N ticks, or only on `seq` gap)? Define the client's drop-detection → resync request.
6. **Soak-test budget in CI:** a 2–3 min headed soak is slow for every PR. Run the full soak nightly/on-demand, with a short (~30 s) flat-heap smoke per PR? Confirm the Chromium launch flags (`--enable-precise-memory-info`, `--js-flags=--expose-gc`) are acceptable in CI.
7. **Exception badge on the map vs feed-only:** do exceptions only populate the side feed (VIZ-04/UI-01), or also visually mark the map feature (extra bucket/overlay)? Affects Q4 cache design and clutter/declutter.

---

*Phase 5 research for: Simulation + Visualization Wrapper (TS + React 19 + Vite + OpenLayers 10.9 + OSM; Fastify + ws; event-sourced Postgres twin). Google AI Mode reachable for all five questions; every AI claim cross-checked against official `ol` 10 docs/examples before adoption.*
*Researched: 2026-06-19 — leave untracked; the orchestrator owns commits.*
