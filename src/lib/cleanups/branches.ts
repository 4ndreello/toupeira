import { DAY, short } from "../format.js";
import { cachedBranchRefs, cachedDefaultBranch, cachedMerged, cachedRemotes, cachedWorktrees, isContentMerged, parseWorktrees } from "../repo.js";
import type { BranchRef } from "../repo.js";
import type { Ctx, CollectResult, Item } from "../../types.js";

export const cats: Record<string, string> = {
  "branch-gone": "local branches fully absorbed elsewhere",
};

// defaultBranch answers with whatever origin head points at, that is origin main, which
// can never equal a local branch name, strip the remote so the default branch itself is
// excluded below. only the first segment goes, and only when a remote of that name exists:
// feature x is a perfectly ordinary branch name.
function localName(remotes: string[], base: string): string {
  const hit = remotes.find((remote) => base.startsWith(`${remote}/`));
  return hit ? base.slice(hit.length + 1) : base;
}

// the graveyard: a branch whose patch is already upstream (squash included) and whose
// remote side is gone has nothing left to protect. checked out, unmerged, young or
// still published branches never reach here.
export async function collect(ctx: Partial<Ctx>): Promise<CollectResult> {
  const { repos = new Set<string>(), days = 7, now = Date.now(), onProgress = () => {} } = ctx;
  let completed = 0;
  const results = await Promise.all([...repos].map(async (repo) => {
    const result = await collectRepo(ctx, repo, days, now, onProgress);
    onProgress(`branches ${++completed}/${repos.size} ${short(repo)}`);
    return result;
  }));
  return { items: results.flatMap((result) => result.items) };
}

async function collectRepo(
  ctx: Partial<Ctx>,
  repo: string,
  days: number,
  now: number,
  onProgress: (msg: string) => void,
): Promise<CollectResult> {
  const [base, remotes, worktreeList, refs] = await Promise.all([
    cachedDefaultBranch(ctx, repo),
    cachedRemotes(ctx, repo),
    cachedWorktrees(ctx, repo),
    cachedBranchRefs(ctx, repo),
  ]);
  if (!base) return { items: [] };
  const localBase = localName(remotes, base);
  const busy = new Set(parseWorktrees(worktreeList).map((worktree) => worktree.branch));
  const candidates = refs.filter((ref) => eligible(ref, base, localBase, busy, days, now));
  const gone = candidates.filter(hasGoneUpstream);
  if (!gone.length) return { items: [] };
  const merged = await cachedMerged(ctx, repo, base);
  let completed = 0;
  const results = await Promise.all(gone.map(async (ref) => {
    const item = await collectCandidate(ctx, repo, ref, base, merged, now);
    onProgress(`branches ${short(repo)} ${++completed}/${gone.length}`);
    return item;
  }));
  return { items: results.filter((item): item is Item => item !== null) };
}

function eligible(ref: BranchRef, base: string, localBase: string, busy: Set<string | null>, days: number, now: number): boolean {
  const timestamp = Number(ref.timestamp) * 1000;
  const age = timestamp ? Math.floor((now - timestamp) / DAY) : 0;
  return Boolean(ref.branch && timestamp && ref.branch !== base && ref.branch !== localBase && !busy.has(ref.branch) && age >= days);
}

function hasGoneUpstream(ref: BranchRef): boolean {
  return Boolean(ref.upstream && ref.remoteref.startsWith("refs/heads/") && ref.track === "[gone]");
}

async function collectCandidate(
  ctx: Partial<Ctx>,
  repo: string,
  ref: BranchRef,
  base: string,
  merged: Set<string>,
  now: number,
): Promise<Item | null> {
  if (!await isContentMerged(repo, ref.branch, base, merged, ctx)) return null;
  const age = Math.floor((now - Number(ref.timestamp) * 1000) / DAY);
  return {
    cat: "branch-gone",
    repo,
    // display and dedupe only: nothing on disk is removed, the target is a ref, and
    // branch delete declares frees false so this path is never measured either
    path: repo,
    // the ref is what goes, so the ui, the success line and the log say which one:
    // every branch of a repo would print the same row otherwise
    label: `${repo}#${ref.branch}`,
    size: 0,
    safe: true,
    note: `${ref.branch} (${age}d), merged into ${base}, ${ref.upstream} deleted`,
    action: { kind: "branch-delete", repo, branch: ref.branch },
  };
}
