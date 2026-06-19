import type { HubDto } from "@mm/api";

export type { HubDto };

/**
 * Fetch hubs from the API. Uses the same-origin `/api` prefix (Vite proxies it
 * to the Fastify server in dev; a reverse proxy does so in any deployment).
 */
export async function fetchHubs(
  signal?: AbortSignal,
): Promise<readonly HubDto[]> {
  const res = await fetch("/api/hubs", signal ? { signal } : {});
  if (!res.ok) {
    throw new Error(`GET /api/hubs failed: ${res.status}`);
  }
  return (await res.json()) as HubDto[];
}
