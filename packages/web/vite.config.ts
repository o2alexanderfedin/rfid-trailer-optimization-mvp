import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy API calls to the Fastify server in dev so the web app uses a
    // same-origin `/api` prefix.
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        // Forward the `/api/ws` snapshot channel as a real websocket upgrade so
        // live trailer points work under `pnpm dev` (VIZ-01 human-verify).
        ws: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
  preview: {
    port: 4173,
  },
});
