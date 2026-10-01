import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DAY, short } from "../format.js";
import { cachedBranchRefs, cachedCommonDir, cachedDefaultBranch, cachedMerged, cachedRemotes, cachedWorktrees, isContentMerged, parseWorktrees } from "../repo.js";
import type { BranchRef } from "../repo.js";
import type { Ctx, CollectResult, Item } from "../../types.js";

export const cats: Record<string, string> = {
  "branch-merged": "local branches already in the default branch",
};

// defaultBranch answers with whatever origin head points at, that is origin main, which
// can never equal a local branch name, strip the remote so the default branch itself is
// excluded below. only the first segment goes, and only when a remote of that name exists:
// feature x is a perfectly ordinary branch name.
function localName(remotes: string[], base: string): string {
  const hit = remotes.find((remote) => base.startsWith(`${remote}/`));
  return hit ? base.slice(hit.length + 1) : base;
}

// the graveyard: a branch whose patch is already in the default branch (squash included)
// has nothing left to protect, whatever its upstream says. the upstream was only ever a
// proxy for "these commits exist elsewhere", and merged content is the direct evidence.
// checked out, rebasing, unmerged or recently moved branches never reach here.
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
  const [base, remotes, worktreeList, refs, common] = await Promise.all([
    cachedDefaultBranch(ctx, repo),
    cachedRemotes(ctx, repo),
    cachedWorktrees(ctx, repo),
    cachedBranchRefs(ctx, repo),
    cachedCommonDir(ctx, repo),
  ]);
  if (!base || !common) return { items: [] };
  const localBase = localName(remotes, base);
  const busy = new Set([...parseWorktrees(worktreeList).map((worktree) => worktree.branch), ...rebasing(common)]);
  const candidates = refs
    .map((ref) => ({ ref, age: refAge(common, ref, now) }))
    .filter(({ ref, age }) => eligible(ref, age, base, localBase, busy, days));
  if (!candidates.length) return { items: [] };
  const merged = await cachedMerged(ctx, repo, base);
  let completed = 0;
  const results = await Promise.all(candidates.map(async ({ ref, age }) => {
    const item = await collectCandidate(ctx, repo, ref, age, base, merged);
    onProgress(`branches ${short(repo)} ${++completed}/${candidates.length}`);
    return item;
  }));
  return { items: results.filter((item): item is Item => item !== null) };
}

function eligible(ref: BranchRef, age: number | null, base: string, localBase: string, busy: Set<string | null>, days: number): boolean {
  return Boolean(ref.branch && age !== null && ref.branch !== base && ref.branch !== localBase && !busy.has(ref.branch) && age >= days);
}

// age is when the ref last moved, not when its tip was committed: a branch made from
// main a minute ago carries main's tip date and would look as old as main's last commit.
// the reflog is touched on every update; without one, the tip date is all there is.
function refAge(common: string, ref: BranchRef, now: number): number | null {
  let moved: number;
  try {
    moved = statSync(join(common, "logs/refs/heads", ref.branch)).mtimeMs;
  } catch {
    moved = Number(ref.timestamp) * 1000;
  }
  return moved ? Math.floor((now - moved) / DAY) : null;
}

// a worktree mid-rebase lists as detached, so the branch it is rebasing looks free. git
// would refuse the delete, but the picker should not offer a row that can only fail.
// the branch is named in head-name, under the common dir for the main checkout and
// under worktrees/<id> for each linked one.
function rebasing(common: string): string[] {
  let linked: string[];
  try {
    linked = readdirSync(join(common, "worktrees")).map((id) => join(common, "worktrees", id));
  } catch {
    linked = [];
  }
  return [common, ...linked].flatMap((gitdir) => ["rebase-merge", "rebase-apply"].flatMap((dir) => {
    try {
      return [readFileSync(join(gitdir, dir, "head-name"), "utf8").trim().replace(/^refs\/heads\//, "")];
    } catch {
      return [];
    }
  }));
}

function upstreamNote(ref: BranchRef): string {
  if (!ref.upstream) return "never pushed";
  return ref.track === "[gone]" ? `${ref.upstream} deleted` : `tracks ${ref.upstream}`;
}

async function collectCandidate(
  ctx: Partial<Ctx>,
  repo: string,
  ref: BranchRef,
  age: number | null,
  base: string,
  merged: Set<string>,
): Promise<Item | null> {
  if (!await isContentMerged(repo, ref.branch, base, merged, ctx)) return null;
  return {
    cat: "branch-merged",
    repo,
    // display and dedupe only: nothing on disk is removed, the target is a ref, and
    // branch delete declares frees false so this path is never measured either
    path: repo,
    // the ref is what goes, so the ui, the success line and the log say which one:
    // every branch of a repo would print the same row otherwise
    label: `${repo}#${ref.branch}`,
    size: 0,
    safe: true,
    note: `${ref.branch} (${age}d), merged into ${base}, ${upstreamNote(ref)}`,
    action: { kind: "branch-delete", repo, branch: ref.branch },
  };
}
