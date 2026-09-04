import { existsSync, statSync } from "node:fs";
import { DAY } from "../format.js";
import { CWD_RE, headMatch, walkFiles } from "../sessions.js";
import { harnesses } from "../harnesses.js";
import type { Ctx, CollectResult } from "../../types.js";

export const cats: Record<string, string> = {
  "transcript-old": "old chats, project still here",
};

// chats belonging to a project that is gone are the orphan cleanup item: it takes the
// whole directory. this one only thins out projects that are still here, file by file.
export function collect({ days = 7, home = "", now = Date.now(), onProgress = () => {}, repos = new Set<string>() }: Partial<Ctx>): CollectResult {
  const groups = new Map<string, { h: { name: string }; cwd: string; root: string; files: string[]; first: number; last: number }>();
  onProgress("old chats");

  for (const h of harnesses(home)) {
    if (!h.transcripts) continue;
    const { dir: root, depth } = h.transcripts;
    for (const file of walkFiles(root, depth, ".jsonl")) {
      // mtime, not the last message: it rises again when a session is resumed
      const mtime = statSync(file, { throwIfNoEntry: false })?.mtimeMs;
      if (!mtime) continue;
      if (Math.floor((now - mtime) / DAY) < days) continue;
      const cwd = headMatch(file, CWD_RE);
      if (!cwd || !existsSync(cwd)) continue;
      const key = `${h.name}\0${cwd}`;
      const g = groups.get(key) || { h, cwd, root, files: [], first: Infinity, last: 0 };
      g.files.push(file);
      g.first = Math.min(g.first, mtime);
      g.last = Math.max(g.last, mtime);
      groups.set(key, g);
    }
  }

  const age = (t: number): number => Math.floor((now - t) / DAY);
  const items: CollectResult["items"] = [...groups.values()].map((g) => ({
    cat: "transcript-old",
    repo: g.cwd,
    // the project, for display, the size sort and dedupe. the files are what goes:
    // never rm this path, and remove() refuses anything outside root anyway
    path: g.cwd,
    size: 0,
    safe: false,
    // how stale the chats on offer are, labelled: a bare range reads as noise
    span: `oldest ${age(g.first)}d - newest ${age(g.last)}d`,
    note: `${g.h.name}: ${g.files.length} chat(s), ${age(g.last)}-${age(g.first)}d old`,
    action: { kind: "rm-files" as const, files: g.files, root: g.root, ext: ".jsonl" },
  }));

  return { items };
}
