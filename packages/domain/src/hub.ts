import { z } from "zod";

/**
 * A hub is a node in the middle-mile network. Phase 1 only needs its
 * identity and geographic position (WGS84 lon/lat) to render on the map.
 */
export const hubSchema = z.object({
  hubId: z.string().min(1),
  name: z.string().min(1),
  /** WGS84 latitude in degrees, -90..90. */
  lat: z.number().gte(-90).lte(90),
  /** WGS84 longitude in degrees, -180..180. */
  lon: z.number().gte(-180).lte(180),
});

export type Hub = z.infer<typeof hubSchema>;
