// VIZ-06 / NET-01: copy non-TS runtime assets into `dist/` after `tsc -b`.
//
// `tsc` only emits `.js`/`.d.ts`; it does NOT copy data files. The committed
// generated datasets are read at runtime relative to the COMPILED module
// (`dist/network/`), so any consumer of the BUILT `@mm/simulation` package (e.g.
// `@mm/api`'s optimizer twin-snapshot) finds them:
//   - `road-geometry.generated.json` — read by `loadStaticRoadGeometry` (VIZ-06).
//   - `us-big-cities.generated.json`  — read by `generateBigCityHubs` (NET-01,
//     the continental-topology root data dependency); a built consumer enabling
//     `continentalTopology` would otherwise throw "malformed or missing hubs[]".
// The package's own vitest unit tests resolve these from `src/` (import.meta.url
// points at source), so they don't need this — but the built artifact must be
// self-contained. Pure file copy, no clock/RNG.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");

// Each committed dataset the runtime reads from `dist/network/`.
const ASSETS = [
  join("network", "road-geometry.generated.json"),
  join("network", "us-big-cities.generated.json"),
];

for (const rel of ASSETS) {
  const src = join(pkgRoot, "src", rel);
  const dest = join(pkgRoot, "dist", rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}
