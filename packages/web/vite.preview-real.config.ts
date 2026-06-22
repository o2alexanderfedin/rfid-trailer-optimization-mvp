import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * F-08 — `vite preview` config for the ONE real web↔server e2e.
 *
 * The web bundle talks SAME-ORIGIN `/api/*` (HTTP) and `/api/ws` (WebSocket).
 * The real Fastify server registers its routes at ROOT (`/hubs`, `/kpis`,
 * `/ws`, …) — NO `/api` prefix. In dev, `vite.config.ts`'s `server.proxy`
 * bridges that gap; but the default `vite preview` (used by the hermetic
 * `chromium` project on :4173) has NO proxy, so a real-path e2e there would 404.
 *
 * Vite 7's `PreviewOptions` supports `proxy` (verified in vite's index.d.ts),
 * so this preview config adds the SAME `/api` → real-Fastify bridge as dev:
 *   - strip the `/api` prefix (`rewrite`) so `/api/hubs` → `/hubs`
 *   - `ws: true` so the `/api/ws` upgrade is proxied to the real ws channel
 *   - `changeOrigin: true` so the Host header matches the target
 *
 * Target is the real API booted by `real-e2e.globalSetup.ts` on
 * `MM_E2E_API_PORT ?? 3101`. This is the linchpin that lets the PROD bundle
 * reach the real server with no stubbed boundaries.
 *
 * Reuses the same `react()` plugin + build output as `vite.config.ts` (the
 * preview serves the artifacts produced by `pnpm build`).
 */
const apiPort = process.env.MM_E2E_API_PORT ?? "3101";

export default defineConfig({
  plugins: [react()],
  preview: {
    port: 4273,
    proxy: {
      "/api": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
        // Proxy the `/api/ws` snapshot channel as a real websocket upgrade so
        // the live alert feed + KPI refetch work against the real Fastify ws.
        ws: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
