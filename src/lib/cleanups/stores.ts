import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, CollectResult } from "../../types.js";

export const cats: Record<string, string> = {
  "store-prune": "package stores, thinned by their own tool",
};

// each tool: where its store sits, and the official maintenance command that
// decides itself what is junk. the command is the judge, so there is no age gate.
const TOOLS: { name: string; dir: (home: string) => string; cmd: string[]; why: string }[] = [
  { name: "npm", dir: (home: string) => join(home, ".npm"), cmd: ["npm", "cache", "verify"], why: "cache verify trims its content store" },
  {
    name: "pnpm",
    dir: (home: string) => join(home, process.platform === "darwin" ? "Library/pnpm/store" : ".local/share/pnpm/store"),
    cmd: ["pnpm", "store", "prune"],
    why: "store prune drops unreferenced packages",
  },
];

// days and now go unused on purpose: the tool own command is the judge of what is
// junk, so there is no age gate, a store that exists is offered, whatever its mtime.
export function collect({ home = "", onProgress = () => {}, repos = new Set<string>(), days = 7, now = Date.now() }: Partial<Ctx>): CollectResult {
  const items: CollectResult["items"] = [];
  onProgress("package stores");

  // ponytail: custom locations (npm config get cache, pnpm store path) are missed
  // by these defaults; upgrade path is asking the tool where its store is
  for (const t of TOOLS) {
    const dir = t.dir(home);
    if (!existsSync(dir)) continue;
    items.push({
      cat: "store-prune",
      repo: null,
      // the store directory, for display only: it is never deleted, and command
      // declares frees false so its size stays out of the reclaimable total, only
      // the tool knows how much of its own store it will drop, and that is usually
      // a fraction of it
      path: dir,
      size: 0,
      safe: true,
      note: `${t.name}: ${t.why}, how much it frees is up to the tool`,
      action: { kind: "command", cmd: t.cmd },
    });
  }

  return { items };
}
