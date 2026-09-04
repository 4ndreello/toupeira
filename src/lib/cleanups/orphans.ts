import { existsSync } from "node:fs";
import { join } from "node:path";
import { dirNames } from "../sessions.js";
import { harnesses } from "../harnesses.js";
import type { Ctx, CollectResult } from "../../types.js";

export const cats: Record<string, string> = {
  "session-orphan": "sessions for projects that are gone",
};

// per project state left behind by every harness that keeps one directory per project
export function collect({ home = "", onProgress = () => {}, repos = new Set<string>(), days = 7, now = Date.now() }: Partial<Ctx>): CollectResult {
  const items: CollectResult["items"] = [];
  onProgress("orphan sessions");

  for (const h of harnesses(home)) {
    if (!h.projects) continue;
    const { dir: root, target } = h.projects;
    for (const name of dirNames(root)) {
      const dir = join(root, name);
      const belongsTo = target(dir, name);
      if (!belongsTo || existsSync(belongsTo)) continue;
      items.push({ cat: "session-orphan", repo: null, path: dir, size: 0, safe: true, note: `${h.name}: ${belongsTo} is gone`, action: { kind: "rm", guard: `${root}/` } });
    }
  }

  return { items };
}
