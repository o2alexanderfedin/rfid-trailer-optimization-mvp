/**
 * Minimal ambient type for the dev-only `all-the-cities` dataset (no bundled
 * types, no @types package). Declares ONLY the fields `scripts/generate-hubs.ts`
 * consumes. This file is dev-only (under `scripts/`); the runtime never imports
 * `all-the-cities`, so this declaration never leaks into the shipped packages.
 */
declare module "all-the-cities" {
  /** One GeoNames-derived city row as exposed by `all-the-cities` v3. */
  export interface AllTheCitiesCity {
    readonly cityId: number;
    readonly name: string;
    readonly altName: string;
    readonly country: string;
    readonly featureCode: string;
    /** In the US dataset this is already the 2-letter postal code (e.g. "TX"). */
    readonly adminCode: string;
    readonly population: number;
    readonly loc: {
      readonly type: "Point";
      /** GeoJSON axis order: `[lon, lat]`. */
      readonly coordinates: readonly [number, number];
    };
  }
  const cities: ReadonlyArray<AllTheCitiesCity>;
  export default cities;
}
