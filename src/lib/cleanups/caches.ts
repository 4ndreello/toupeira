import { statSync } from "node:fs";
import { join } from "node:path";
import { DAY } from "../format.js";
import { entryNames } from "../sessions.js";
import { harnesses } from "../harnesses.js";
import type { Ctx, CollectResult } from "../../types.js";

export const cats: Record<string, string> = {
  "agent-cache": "caches and history outside your projects",
};

// what agents keep next to their sessions: pasted images, shell snapshots, undo
// history. one item per directory, listing only the entries old enough to go,
// an entry is a file (one paste) or a directory (one session images).
// ponytail: mtime per entry, no walk. a stale session directory holding one fresh
// file reads as fresh, which errs towards keeping it.
export function collect({ days = 7, home = "", now = Date.now(), onProgress = () => {}, repos = new Set<string>() }: Partial<Ctx>): CollectResult {
  const items: CollectResult["items"] = [];
  const age = (t: number): number => Math.floor((now - t) / DAY);
  onProgress("agent caches");

  for (const h of harnesses(home)) {
    if (!h.caches) continue;
    for (const { name, what, safe } of h.caches.dirs) {
      const dir = join(h.caches.root, name);
      const old: string[] = [];
      let first = Infinity;
      let last = 0;
      for (const e of entryNames(dir)) {
        const p = join(dir, e);
        const mtime = statSync(p, { throwIfNoEntry: false })?.mtimeMs;
        if (!mtime || age(mtime) < days) continue;
        old.push(p);
        first = Math.min(first, mtime);
        last = Math.max(last, mtime);
      }
      if (!old.length) continue;
      items.push({
        cat: "agent-cache",
        repo: null,
        // the cache directory, for display and the size sort. it is never the
        // target: what goes is action.files, guarded per entry by remove()
        path: dir,
        size: 0,
        safe,
        span: `oldest ${age(first)}d - newest ${age(last)}d`,
        note: `${h.name}: ${old.length} old ${what}`,
        action: { kind: "rm-files", files: old, root: dir },
      });
    }
  }

  return { items };
}
