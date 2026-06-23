/**
 * SpeedControl — the "speed of time" gauge (live sim-speed control).
 *
 * A log-scale range slider (0.25×–64× of the default) + a `sim-min/real-sec`
 * readout + a Pause/Resume button. Dragging the slider POSTs `/api/sim/speed`
 * (debounced); the server retunes the paced driver's tick interval live and
 * echoes the effective speed on every ws envelope. The component reflects the
 * SERVER-CONFIRMED `envelope.speed` (subscribed via WsContext) for display, so
 * the readout never drifts from the authoritative state.
 *
 * Pure helpers (exported, unit-tested in Node — no DOM):
 *  - `multiplierToSlider` / `sliderToMultiplier`: log2 mapping (even spacing).
 *  - `formatReadout`: "2.00× · ~4 sim-min/real-sec".
 *  - `speedChanged`: minimal-diff guard (avoid per-tick re-render).
 *  - `SLIDER_MIN` / `SLIDER_MAX` / `SLIDER_STEP`: slider domain.
 *
 * Realtime discipline: the envelope subscription only `setState` when the speed
 * actually changes (not every tick), and the component is mounted in the right
 * rail — fully decoupled from the OL map (no map re-render coupling).
 */
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { WsContext } from "../map/WsProvider.js";
import { setSimSpeed } from "../api/client.js";
import type { SimSpeedState } from "../api/client.js";

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Multiplier bounds (relative to the default 1×) — mirror the server clamp. */
export const MIN_MULTIPLIER = 0.25;
export const MAX_MULTIPLIER = 64;

/** Slider domain in log2 space: log2(0.25)=-2 … log2(64)=6. */
export const SLIDER_MIN = Math.log2(MIN_MULTIPLIER); // -2
export const SLIDER_MAX = Math.log2(MAX_MULTIPLIER); // 6
/** 0.05 ≈ ~3.5% multiplier steps — smooth without flooding the server. */
export const SLIDER_STEP = 0.05;

/** Map a multiplier onto its log-scale slider value (clamped to the domain). */
export function multiplierToSlider(multiplier: number): number {
  const m = Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, multiplier));
  return Math.log2(m);
}

/** Map a log-scale slider value back onto a multiplier (clamped to bounds). */
export function sliderToMultiplier(sliderValue: number): number {
  const m = 2 ** sliderValue;
  return Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, m));
}

/**
 * The human-readable gauge readout. `tickIntervalMs` drives the sim-min/real-sec
 * figure: each tick is 1 sim-minute, so `1000 / tickIntervalMs` ticks fire per
 * real second ⇒ that many sim-minutes per real second.
 */
export function formatReadout(multiplier: number, tickIntervalMs: number): string {
  const simMinPerSec = Math.round(1000 / tickIntervalMs);
  return `${multiplier.toFixed(2)}× · ~${simMinPerSec} sim-min/real-sec`;
}

/** True iff two SimSpeedStates differ in any field (re-render guard). */
export function speedChanged(a: SimSpeedState, b: SimSpeedState): boolean {
  return (
    a.multiplier !== b.multiplier ||
    a.tickIntervalMs !== b.tickIntervalMs ||
    a.simSpeed !== b.simSpeed ||
    a.paused !== b.paused
  );
}

/** The default 1× state shown before the first envelope arrives. */
export const DEFAULT_SPEED: SimSpeedState = {
  multiplier: 1,
  tickIntervalMs: 500,
  simSpeed: 120,
  paused: false,
};

/** Debounce window (ms) for slider-driven POSTs. */
const POST_DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * The sim-speed gauge. Mounted in the right rail; decoupled from the map.
 */
export function SpeedControl(): React.JSX.Element {
  const { registry } = useContext(WsContext);

  // Server-confirmed speed (drives the display). Only updated when it changes.
  const [speed, setSpeed] = useState<SimSpeedState>(DEFAULT_SPEED);
  // The slider's live value (log2 multiplier) — local while dragging, then the
  // server confirmation re-anchors it.
  const [sliderValue, setSliderValue] = useState<number>(
    multiplierToSlider(DEFAULT_SPEED.multiplier),
  );

  const speedRef = useRef<SimSpeedState>(speed);
  speedRef.current = speed;
  const draggingRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const postAcRef = useRef<AbortController | null>(null);

  // --- Subscribe to server-confirmed speed (only re-render on a real change) --
  useEffect(() => {
    const unsub = registry.subscribe((envelope) => {
      const next = envelope.speed;
      if (!speedChanged(speedRef.current, next)) return;
      speedRef.current = next;
      setSpeed(next);
      // Re-anchor the slider to the confirmed multiplier UNLESS the user is
      // mid-drag (don't fight their input).
      if (!draggingRef.current) {
        setSliderValue(multiplierToSlider(next.multiplier));
      }
    });
    return unsub;
  }, [registry]);

  // --- Clean up timers / in-flight POST on unmount --------------------------
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      postAcRef.current?.abort();
    };
  }, []);

  /** Debounced POST of a speed change (coalesces rapid slider drags). */
  const postSpeed = useCallback(
    (input: { multiplier?: number; paused?: boolean }): void => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        postAcRef.current?.abort();
        const ac = new AbortController();
        postAcRef.current = ac;
        setSimSpeed(input, ac.signal).catch(() => {
          // Aborted or transient error — the next envelope re-confirms state.
        });
      }, POST_DEBOUNCE_MS);
    },
    [],
  );

  const onSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      draggingRef.current = true;
      const value = Number(e.target.value);
      setSliderValue(value);
      postSpeed({ multiplier: sliderToMultiplier(value) });
    },
    [postSpeed],
  );

  const onSliderCommit = useCallback((): void => {
    // Drag finished — allow envelope confirmations to re-anchor the slider.
    draggingRef.current = false;
  }, []);

  const onTogglePause = useCallback((): void => {
    const next = !speedRef.current.paused;
    postSpeed({ paused: next });
  }, [postSpeed]);

  const liveMultiplier = sliderToMultiplier(sliderValue);

  return (
    <section className="speed-control" data-testid="speed-control">
      <header className="speed-control__header">
        <span className="speed-control__title">Speed of Time</span>
        <span className="speed-control__readout" data-testid="speed-readout">
          {formatReadout(liveMultiplier, speed.tickIntervalMs)}
        </span>
      </header>
      <div className="speed-control__row">
        <button
          type="button"
          className={`speed-control__pause${speed.paused ? " speed-control__pause--paused" : ""}`}
          data-testid="speed-pause"
          aria-pressed={speed.paused}
          onClick={onTogglePause}
        >
          {speed.paused ? "Resume" : "Pause"}
        </button>
        <input
          type="range"
          className="speed-control__slider"
          data-testid="speed-slider"
          aria-label="Simulation speed"
          min={SLIDER_MIN}
          max={SLIDER_MAX}
          step={SLIDER_STEP}
          value={sliderValue}
          onChange={onSliderChange}
          onMouseUp={onSliderCommit}
          onTouchEnd={onSliderCommit}
          onBlur={onSliderCommit}
        />
      </div>
    </section>
  );
}
