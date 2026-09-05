import { existsSync } from "node:fs";
import { join } from "node:path";
import { DAY, short } from "../format.js";
import { git } from "../sh.js";
import { cachedDefaultBranch, cachedMerged, cachedWorktrees, isContentMerged, parseWorktrees, unpushed } from "../repo.js";
import type { Ctx, CollectResult } from "../../types.js";

export const cats: Record<string, string> = {
  "worktree-prunable": "stale worktree registrations",
  "worktree-merged": "merged worktrees",
  "worktree-stale": "idle worktrees, not merged",
  node_modules: "node_modules inside a worktree",
};

// node_modules rides along in here instead of its own cleanup: it needs the same
// git status and log and merge base work per worktree, and splitting would run it twice.
export function collect(ctx: Partial<Ctx>): CollectResult {
  const { repos = new Set<string>(), days = 7, now = Date.now(), onProgress = () => {}, home = "" } = ctx;
  const items: CollectResult["items"] = [];
  const kept: { path: string; why: string }[] = [];
  let n = 0;

  for (const repo of repos) {
    onProgress(`worktrees ${++n}/${repos.size} ${short(repo)}`);
    const list = cachedWorktrees(ctx, repo);
    if (!list) continue;
    const candidates = parseWorktrees(list).filter((w) => w.path !== repo && !w.bare);
    if (candidates.length === 0) continue;
    const base = cachedDefaultBranch(ctx, repo);
    // read once per repo, not once per worktree: isContentMerged would fork a full
    // history walk for every candidate otherwise
    const mergedSet = cachedMerged(ctx, repo, base);

    for (const w of candidates) {
      if (w.prunable || !existsSync(w.path)) {
        items.push({ cat: "worktree-prunable", repo, path: w.path, size: 0, safe: true, note: "registered here, but the directory is gone", action: { kind: "prune", repo } });
        continue;
      }

      const dirty = (git(["status", "--porcelain"], w.path) || "").length > 0;
      const ts = Number(git(["log", "-1", "--format=%ct"], w.path) || 0) * 1000;
      const age = ts ? Math.floor((now - ts) / DAY) : 0;
      const ahead = w.branch ? unpushed(repo, w.branch) : null;
      const merged = w.branch ? isContentMerged(repo, w.branch, base, mergedSet) : false;
      const nm = join(w.path, "node_modules");
      const label = `${w.branch || w.head?.slice(0, 7)} (${age}d)`;

      if (existsSync(nm) && age >= days) {
        items.push({ cat: "node_modules", repo, path: nm, size: 0, safe: true, note: `${label}, reinstallable`, action: { kind: "rm", guard: "/node_modules" } });
      }

      if (dirty) {
        kept.push({ path: w.path, why: "uncommitted changes" });
        continue;
      }
      if (merged) {
        items.push({ cat: "worktree-merged", repo, path: w.path, size: 0, safe: true, note: `${label}, already in ${base}`, action: { kind: "worktree-remove", repo } });
      } else if (ahead === null) {
        kept.push({ path: w.path, why: "no upstream, these commits exist nowhere else" });
      } else if (ahead > 0) {
        kept.push({ path: w.path, why: `${ahead} unpushed commit(s)` });
      } else if (age >= days) {
        items.push({ cat: "worktree-stale", repo, path: w.path, size: 0, safe: false, note: `${label}, pushed, not merged`, action: { kind: "worktree-remove", repo } });
      } else {
        kept.push({ path: w.path, why: `recent (${age}d)` });
      }
    }
  }

  return { items, kept };
}
