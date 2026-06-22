// VIZ-06: copy non-TS runtime assets into `dist/` after `tsc -b`.
//
// `tsc` only emits `.js`/`.d.ts`; it does NOT copy data files. The committed ORS
// road geometry (`road-geometry.generated.json`) is read at runtime by
// `loadStaticRoadGeometry` relative to the COMPILED module (`dist/network/`), so
// any consumer of the BUILT `@mm/simulation` package (e.g. `@mm/api`'s optimizer
// twin-snapshot) finds it. The package's own vitest unit tests resolve the file
// from `src/` (import.meta.url points at source), so they don't need this — but
// the built artifact must be self-contained. Pure file copy, no clock/RNG.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const rel = join("network", "road-geometry.generated.json");
const src = join(pkgRoot, "src", rel);
const dest = join(pkgRoot, "dist", rel);

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
