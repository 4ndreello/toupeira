import { DAY, short } from "../format.js";
import { git } from "../sh.js";
import { cachedDefaultBranch, cachedMerged, cachedRemotes, cachedWorktrees, isContentMerged, parseWorktrees } from "../repo.js";
import type { Ctx, CollectResult } from "../../types.js";

export const cats: Record<string, string> = {
  "branch-gone": "local branches fully absorbed elsewhere",
};

// defaultBranch answers with whatever origin head points at, that is origin main, which
// can never equal a local branch name, strip the remote so the default branch itself is
// excluded below. only the first segment goes, and only when a remote of that name exists:
// feature x is a perfectly ordinary branch name.
function localName(remotes: string[], base: string): string {
  const hit = remotes.find((r) => base.startsWith(`${r}/`));
  return hit ? base.slice(hit.length + 1) : base;
}

// the graveyard: a branch whose patch is already upstream (squash included) and whose
// remote side is gone has nothing left to protect. checked out, unmerged, young or
// still published branches never reach here.
export function collect(ctx: Partial<Ctx>): CollectResult {
  const { repos = new Set<string>(), days = 7, now = Date.now(), onProgress = () => {}, home = "" } = ctx;
  const items: CollectResult["items"] = [];
  let n = 0;

  for (const repo of repos) {
    onProgress(`branches ${++n}/${repos.size} ${short(repo)}`);
    const base = cachedDefaultBranch(ctx, repo);
    if (!base) continue;
    const localBase = localName(cachedRemotes(ctx, repo), base);
    const current = git(["symbolic-ref", "--short", "HEAD"], repo);
    // a branch checked out in any worktree cannot go: deleting it breaks that worktree
    const busy = new Set(parseWorktrees(cachedWorktrees(ctx, repo)).map((w) => w.branch));
    const list = git(["for-each-ref", "refs/heads", "--format=%(refname:short)%09%(committerdate:unix)%09%(upstream:short)%09%(upstream:track)%09%(upstream:remoteref)"], repo);
    if (!list) continue;
    // read once per repo, not once per branch: isContentMerged would fork a full
    // history walk for every candidate otherwise
    const merged = cachedMerged(ctx, repo, base);

    for (const line of list.split("\n")) {
      // exactly five tab fields, split whole: branch names hold slashes but never
      // tabs, and the upstream short stays whole for the same reason
      const f = line.split("\t");
      if (f.length !== 5) continue;
      const [branch, rawTs, upstream, track, remoteref] = f;
      const ts = Number(rawTs) * 1000;
      if (!branch || !ts || branch === base || branch === localBase || branch === current || busy.has(branch)) continue;
      const age = Math.floor((now - ts) / DAY);
      if (age < days) continue;

      // the tracking config is the evidence, read in the same fork as the listing:
      // no upstream at all means the branch may hold the only copy of its commits,
      // so it stays. only [gone] proves the remote side vanished: synced is empty
      // and ahead/behind keep their markers, so match exactly, never truthiness.
      // a local upstream (remote .) always resolves, so it skips here, where the
      // old rev-parse of refs/remotes/./name failed open and offered it.
      if (!upstream || !remoteref?.startsWith("refs/heads/") || track !== "[gone]") continue;
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
        note: `${branch} (${age}d), merged into ${base}, ${upstream} deleted`,
        action: { kind: "branch-delete", repo, branch },
      });
    }
  }

  return { items };
}
