import type { HubDto, RouteDto } from "@mm/api";

export type { HubDto, RouteDto };

/**
 * Typed read-only fetch helpers for the map geo endpoints (Plan 06 contracts).
 *
 * Both use the same-origin `/api` prefix — Vite proxies it to the Fastify
 * server in dev, and a reverse proxy does so in any deployment — so the web app
 * never hard-codes the API host (and the e2e can stub the boundary).
 */

/** `GET /api/hubs` -> all ~10 USA hubs (`{ hubId, name, lat, lon }`). */
export async function fetchHubs(
  signal?: AbortSignal,
): Promise<readonly HubDto[]> {
  const res = await fetch("/api/hubs", signal ? { signal } : {});
  if (!res.ok) {
    throw new Error(`GET /api/hubs failed: ${res.status}`);
  }
  return (await res.json()) as HubDto[];
}

/** `GET /api/routes` -> all linehaul routes with `[lon, lat][]` geometry. */
export async function fetchRoutes(
  signal?: AbortSignal,
): Promise<readonly RouteDto[]> {
  const res = await fetch("/api/routes", signal ? { signal } : {});
  if (!res.ok) {
    throw new Error(`GET /api/routes failed: ${res.status}`);
  }
  return (await res.json()) as RouteDto[];
}
