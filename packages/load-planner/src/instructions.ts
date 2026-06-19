import type { LoadBlock } from "@mm/domain";
import { type Zone, zoneForDepth } from "./trailer.js";
import type { LoadPlan } from "./types.js";

/**
 * Human-readable loading instructions (LOAD-08) — the dock-worker card.
 *
 * `instructions(plan, blocks)` groups the placed blocks by their trailer zone
 * (`zoneForDepth`: nose/middle/rear, derived from depth thirds — single-sourced
 * with `trailer.ts`) and lists them in PHYSICAL LOAD ORDER: nose loaded FIRST
 * (deepest), rear LAST (the door). Each line names the block and its destination
 * (next-unload) hub so the loader knows what goes where and why.
 *
 * Pure + deterministic: imports only `@mm/domain` (types) + local pure modules;
 * no clock, no RNG. Same `(plan, blocks)` ⇒ identical card.
 */

/** One line of the loading card: a block and the hub it is bound for. */
export interface InstructionLine {
  readonly loadBlockId: string;
  readonly destHubId: string;
}

/** All blocks in one trailer zone, in deterministic order. */
export interface ZoneInstruction {
  readonly zone: Zone;
  readonly lines: readonly InstructionLine[];
}

/**
 * The full loading card: per-zone instruction groups in physical load order
 * (nose → middle → rear) plus a rendered plain-text version for display.
 */
export interface LoadingInstructions {
  readonly trailerId: string;
  readonly zones: readonly ZoneInstruction[];
  readonly text: string;
}

/** Physical load order: load the nose (deepest) first, the rear door last. */
const ZONE_LOAD_ORDER: readonly Zone[] = ["nose", "middle", "rear"];

/** Capitalised zone label for the rendered card. */
const ZONE_LABEL: Record<Zone, string> = {
  nose: "Nose",
  middle: "Middle",
  rear: "Rear",
};

/**
 * Build the loading card. The slice count drives `zoneForDepth`; blocks are
 * looked up by id for their destination hub. Empty zones are omitted. Within a
 * zone, lines are ordered by depth (deeper first) then by `loadBlockId` for a
 * stable, replayable card.
 */
export function instructions(
  plan: LoadPlan,
  blocks: readonly LoadBlock[],
): LoadingInstructions {
  const sliceCount = plan.slices.length;
  const hubByBlockId = new Map(
    blocks.map((b) => [b.loadBlockId, b.key.nextUnloadHubId]),
  );

  // Collect (zone, depth, line) for every placed block, deepest first.
  const collected: { zone: Zone; depth: number; line: InstructionLine }[] = [];
  for (const slice of plan.slices) {
    const zone = zoneForDepth(slice.depth, sliceCount);
    // id-stable within a slice (determinism, P3).
    const ids = [...slice.loadBlockIds].sort((a, b) => (a < b ? -1 : 1));
    for (const loadBlockId of ids) {
      const destHubId = hubByBlockId.get(loadBlockId) ?? "?";
      collected.push({ zone, depth: slice.depth, line: { loadBlockId, destHubId } });
    }
  }

  // Group into the three zones in physical load order, dropping empties.
  const zones: ZoneInstruction[] = [];
  for (const zone of ZONE_LOAD_ORDER) {
    const lines = collected
      .filter((c) => c.zone === zone)
      // deeper first, then id — matches the physical load sequence.
      .sort((a, b) =>
        b.depth - a.depth || (a.line.loadBlockId < b.line.loadBlockId ? -1 : 1),
      )
      .map((c) => c.line);
    if (lines.length > 0) zones.push({ zone, lines });
  }

  const text = renderText(plan.trailerId, zones);
  return { trailerId: plan.trailerId, zones, text };
}

/** Render the per-zone groups into a single plain-text loading card. */
function renderText(
  trailerId: string,
  zones: readonly ZoneInstruction[],
): string {
  const header = `Loading instructions for ${trailerId} (load nose → rear):`;
  const body = zones.map((z) => {
    const items = z.lines
      .map((l) => `${l.loadBlockId} (→ ${l.destHubId})`)
      .join(", ");
    return `${ZONE_LABEL[z.zone]}: ${items}`;
  });
  return [header, ...body].join("\n");
}
