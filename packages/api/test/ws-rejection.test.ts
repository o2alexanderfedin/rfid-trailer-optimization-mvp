import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WebSocket } from "ws";
import { attachSnapshotSocket, type ApiDb } from "../src/index.js";

/**
 * M-5: a DB blip on ws connect must NOT crash the process. The fire-and-forget
 * initial-snapshot build had no `.catch`, so a rejecting DB read produced an
 * unhandled promise rejection — fatal under Node's default `--unhandled-rejections=throw`.
 *
 * This test injects a `buildPayload` that REJECTS (simulating the transient DB
 * read failure) and asserts that:
 *   (a) no `unhandledRejection` fires on the process, and
 *   (b) the server gracefully CLOSES the socket so the client can reconnect.
 *
 * It needs no Postgres — the db handle is never touched because the injected
 * payload builder rejects before any query — so it runs in the unit project.
 */

const FAKE_DB = {} as unknown as ApiDb;

async function buildWsApp(
  buildPayload: () => Promise<never>,
): Promise<{ app: FastifyInstance; port: number }> {
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  attachSnapshotSocket(app, FAKE_DB, { buildPayload });
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server did not bind a TCP port");
  }
  return { app, port: address.port };
}

describe("ws snapshot channel: initial-snapshot rejection is handled (M-5)", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("a rejecting buildPayload on connect closes the socket and does not throw unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const built = await buildWsApp(() =>
        Promise.reject(new Error("simulated transient DB read failure")),
      );
      app = built.app;

      const socket = new WebSocket(`ws://127.0.0.1:${built.port}/ws`);

      // The server must CLOSE the socket (graceful failure) rather than hang or
      // crash. Wait for the close event (or fail on a timeout).
      const closed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5_000);
        socket.once("close", () => {
          clearTimeout(timer);
          resolve(true);
        });
        socket.once("error", () => {
          clearTimeout(timer);
          resolve(true); // a transport error also satisfies "did not hang"
        });
      });
      expect(closed).toBe(true);

      // Give any (mis)handled rejection a tick to surface on the event loop.
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
