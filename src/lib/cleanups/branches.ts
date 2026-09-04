import { DAY, short } from "../format.js";
import { git } from "../sh.js";
import { defaultBranch, isContentMerged, mergedBranches, parseWorktrees } from "../repo.js";
import type { Ctx, CollectResult } from "../../types.js";

export const cats: Record<string, string> = {
  "branch-gone": "local branches fully absorbed elsewhere",
};

// defaultBranch answers with whatever origin head points at, that is origin main, which
// can never equal a local branch name, strip the remote so the default branch itself is
// excluded below. only the first segment goes, and only when a remote of that name exists:
// feature x is a perfectly ordinary branch name.
function localName(repo: string, base: string): string {
  const remotes = (git(["remote"], repo) || "").split("\n").filter(Boolean);
  const hit = remotes.find((r) => base.startsWith(`${r}/`));
  return hit ? base.slice(hit.length + 1) : base;
}

// the graveyard: a branch whose patch is already upstream (squash included) and whose
// remote side is gone has nothing left to protect. checked out, unmerged, young or
// still published branches never reach here.
export function collect({ repos = new Set<string>(), days = 7, now = Date.now(), onProgress = () => {}, home = "" }: Partial<Ctx>): CollectResult {
  const items: CollectResult["items"] = [];
  let n = 0;

  for (const repo of repos) {
    onProgress(`branches ${++n}/${repos.size} ${short(repo)}`);
    const base = defaultBranch(repo);
    if (!base) continue;
    const localBase = localName(repo, base);
    const current = git(["symbolic-ref", "--short", "HEAD"], repo);
    // a branch checked out in any worktree cannot go: deleting it breaks that worktree
    const busy = new Set(parseWorktrees(git(["worktree", "list", "--porcelain"], repo) || "").map((w) => w.branch));
    const list = git(["for-each-ref", "refs/heads", "--format=%(refname:short)%09%(committerdate:unix)"], repo);
    if (!list) continue;
    // read once per repo, not once per branch: isContentMerged would fork a full
    // history walk for every candidate otherwise
    const merged = mergedBranches(repo, base);

    for (const line of list.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      const branch = line.slice(0, tab);
      const ts = Number(line.slice(tab + 1)) * 1000;
      if (!branch || !ts || branch === base || branch === localBase || branch === current || busy.has(branch)) continue;
      const age = Math.floor((now - ts) / DAY);
      if (age < days) continue;

      // at upstream dies when the tracking ref is gone, so read the config instead:
      // it remembers an upstream that was deleted on the remote, which is exactly the
      // evidence this cleanup needs. no config at all is no evidence, a branch that
      // was never published may hold the only copy of its commits, so it stays.
      const remote = git(["config", "--get", `branch.${branch}.remote`], repo);
      const merge = git(["config", "--get", `branch.${branch}.merge`], repo);
      if (!remote || !merge || !merge.startsWith("refs/heads/")) continue;
      const name = merge.slice("refs/heads/".length);
      if (git(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${name}`], repo)) continue;
      if (!isContentMerged(repo, branch, base, merged)) continue;

      items.push({
        cat: "branch-gone",
        repo,
        // display and dedupe only: nothing on disk is removed, the target is a ref, and
        // branch delete declares frees false so this path is never measured either
        path: repo,
        // the ref is what goes, so the ui, the success line and the log say which one:
        // every branch of a repo would print the same row otherwise
        label: `${repo}#${branch}`,
        size: 0,
        safe: true,
        note: `${branch} (${age}d), merged into ${base}, ${remote}/${name} deleted`,
        action: { kind: "branch-delete", repo, branch },
      });
    }
  }

  return { items };
}
