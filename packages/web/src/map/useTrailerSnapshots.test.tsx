/**
 * useTrailerSnapshots.ts jsdom reference test (the `ui` / jsdom lane).
 *
 * `useTrailerSnapshots` opens a raw `WebSocket` to the same-origin `/api/ws`
 * channel, parses each `{ t:'snapshot', trailers:[...] }` message, and hands the
 * narrowed snapshot to a caller-supplied handler WITHOUT React state (realtime
 * discipline — the OL map mutates features off the render path).
 *
 * The MSW `ws.link("ws://*\/api/ws")` from the shared handlers intercepts the
 * socket inside the jsdom process. The shared default handler emits `WsEnvelope`
 * shapes (`{ type, payload }`), which are NOT this hook's `SnapshotMessage` shape
 * (`{ t:'snapshot', trailers }`) and are correctly ignored by its read guard.
 * So each test installs a per-test `server.use(api.addEventListener(...))`
 * override that pushes hook-shaped envelopes — the shared handlers file is never
 * edited (concurrency-safe), and the jsdom setup resets handlers between tests.
 *
 * Coverage goal: useTrailerSnapshots.ts 0% -> ~90% (open, parse, narrow each
 * field/fallback, ignore malformed, close on unmount).
 */
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { server } from "../../test/msw/server.js";
import { api } from "../../test/msw/handlers.js";
import {
  useTrailerSnapshots,
  type SnapshotMessage,
} from "./useTrailerSnapshots.js";

/**
 * Install a per-test `/api/ws` handler that, on connect, sends each provided
 * JSON string to the client. Strings (not objects) let us inject malformed and
 * non-snapshot payloads to exercise the read-side guard's reject branches.
 */
function sendOnConnect(...messages: readonly string[]): void {
  server.use(
    api.addEventListener("connection", ({ client }) => {
      for (const message of messages) client.send(message);
    }),
  );
}

/** A hook-shaped snapshot envelope (the wire shape `asSnapshot` accepts). */
function snapshotEnvelope(
  trailers: readonly unknown[],
): string {
  return JSON.stringify({ t: "snapshot", trailers });
}

describe("useTrailerSnapshots (jsdom ui lane)", () => {
  it("delivers a parsed snapshot with every field mapped through", async () => {
    sendOnConnect(
      snapshotEnvelope([
        {
          trailerId: "T-100",
          tripId: "TRIP-1",
          kind: "linehaul",
          lon: -118.4085,
          lat: 33.9416,
          t: "2026-06-21T00:00:00.000Z",
        },
      ]),
    );

    const onSnapshot = vi.fn<(snapshot: SnapshotMessage) => void>();
    renderHook(() => useTrailerSnapshots(onSnapshot));

    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));
    const snapshot = onSnapshot.mock.calls[0]?.[0];
    expect(snapshot?.t).toBe("snapshot");
    expect(snapshot?.trailers).toEqual([
      {
        trailerId: "T-100",
        tripId: "TRIP-1",
        kind: "linehaul",
        lon: -118.4085,
        lat: 33.9416,
        t: "2026-06-21T00:00:00.000Z",
      },
    ]);
  });

  it("updates the consumer on each successive snapshot envelope", async () => {
    sendOnConnect(
      snapshotEnvelope([
        { trailerId: "T-1", tripId: "A", kind: "linehaul", lon: -100, lat: 40, t: "t0" },
      ]),
      snapshotEnvelope([
        { trailerId: "T-1", tripId: "A", kind: "linehaul", lon: -90, lat: 41, t: "t1" },
      ]),
    );

    const onSnapshot = vi.fn<(snapshot: SnapshotMessage) => void>();
    renderHook(() => useTrailerSnapshots(onSnapshot));

    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(2));
    expect(onSnapshot.mock.calls[0]?.[0].trailers[0]?.lon).toBe(-100);
    expect(onSnapshot.mock.calls[1]?.[0].trailers[0]?.lon).toBe(-90);
  });

  it("fills defaults for missing optional string fields (tripId/kind/t)", async () => {
    sendOnConnect(
      // Only the required trailerId/lon/lat present — tripId, kind, t omitted.
      snapshotEnvelope([{ trailerId: "T-bare", lon: -97.0403, lat: 32.8998 }]),
    );

    const onSnapshot = vi.fn<(snapshot: SnapshotMessage) => void>();
    renderHook(() => useTrailerSnapshots(onSnapshot));

    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));
    expect(onSnapshot.mock.calls[0]?.[0].trailers[0]).toEqual({
      trailerId: "T-bare",
      tripId: "",
      kind: "",
      lon: -97.0403,
      lat: 32.8998,
      t: "",
    });
  });

  it("drops trailer entries missing required fields but keeps valid ones", async () => {
    sendOnConnect(
      snapshotEnvelope([
        // valid
        { trailerId: "T-ok", tripId: "X", kind: "linehaul", lon: -118, lat: 34, t: "t" },
        // rejected: lat is not a number
        { trailerId: "T-bad-lat", lon: -97, lat: "32.9" },
        // rejected: trailerId is not a string
        { trailerId: 42, lon: -87, lat: 41 },
        // rejected: lon missing entirely
        { trailerId: "T-no-lon", lat: 41 },
        // rejected: not an object at all
        null,
        "not-an-object",
      ]),
    );

    const onSnapshot = vi.fn<(snapshot: SnapshotMessage) => void>();
    renderHook(() => useTrailerSnapshots(onSnapshot));

    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));
    const trailers = onSnapshot.mock.calls[0]?.[0].trailers;
    expect(trailers).toHaveLength(1);
    expect(trailers?.[0]?.trailerId).toBe("T-ok");
  });

  it("delivers an empty trailer list when the snapshot has no trailers", async () => {
    sendOnConnect(snapshotEnvelope([]));

    const onSnapshot = vi.fn<(snapshot: SnapshotMessage) => void>();
    renderHook(() => useTrailerSnapshots(onSnapshot));

    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));
    expect(onSnapshot.mock.calls[0]?.[0].trailers).toEqual([]);
  });

  it("ignores non-snapshot, malformed, and wrong-typed payloads", async () => {
    sendOnConnect(
      // wrong discriminator (`type`/`payload` envelope shape, not `t`/`trailers`)
      JSON.stringify({ type: "snapshot", payload: { trailers: [] } }),
      // right `t` but `trailers` is not an array
      JSON.stringify({ t: "snapshot", trailers: { nope: true } }),
      // a primitive (not an object) — JSON.parse succeeds, guard rejects
      JSON.stringify(123),
      // not valid JSON at all — the try/catch swallows it
      "{not json",
      // finally a real snapshot so we can prove the bad ones were skipped
      snapshotEnvelope([
        { trailerId: "T-real", tripId: "Z", kind: "linehaul", lon: -118, lat: 34, t: "t" },
      ]),
    );

    const onSnapshot = vi.fn<(snapshot: SnapshotMessage) => void>();
    renderHook(() => useTrailerSnapshots(onSnapshot));

    // Only the single well-formed snapshot reaches the handler.
    await waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1));
    expect(onSnapshot.mock.calls[0]?.[0].trailers[0]?.trailerId).toBe("T-real");
  });

  it("uses the latest handler closure without reopening the socket", async () => {
    sendOnConnect(
      snapshotEnvelope([
        { trailerId: "T-1", tripId: "A", kind: "linehaul", lon: -100, lat: 40, t: "t0" },
      ]),
    );

    const first = vi.fn<(snapshot: SnapshotMessage) => void>();
    const second = vi.fn<(snapshot: SnapshotMessage) => void>();

    const { rerender } = renderHook(
      ({ handler }: { handler: (s: SnapshotMessage) => void }) =>
        useTrailerSnapshots(handler),
      { initialProps: { handler: first } },
    );

    await waitFor(() => expect(first).toHaveBeenCalledTimes(1));

    // Swap the handler closure; the ref discipline means the socket stays open
    // and is NOT torn down + reopened (which would re-fire the connect snapshot).
    rerender({ handler: second });
    expect(second).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("closes the socket on unmount and stops delivering snapshots", async () => {
    let connectedClients = 0;
    let closedClients = 0;
    server.use(
      api.addEventListener("connection", ({ client }) => {
        connectedClients += 1;
        client.addEventListener("close", () => {
          closedClients += 1;
        });
      }),
    );

    const onSnapshot = vi.fn<(snapshot: SnapshotMessage) => void>();
    const { unmount } = renderHook(() => useTrailerSnapshots(onSnapshot));

    await waitFor(() => expect(connectedClients).toBe(1));
    unmount();
    await waitFor(() => expect(closedClients).toBe(1));
  });
});
