import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { gitAsync } from "./sh.js";
import type { Ctx } from "../types.js";

export interface Worktree {
  path: string;
  head?: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
}

export function parseWorktrees(porcelain: string): Worktree[] {
  return porcelain
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const o: Record<string, string | boolean> = {};
      for (const line of block.split("\n")) {
        const sp = line.indexOf(" ");
        if (sp === -1) o[line] = true;
        else o[line.slice(0, sp)] = line.slice(sp + 1);
      }
      const rawBranch = o["branch"];
      return {
        path: String(o["worktree"] ?? ""),
        head: typeof o["HEAD"] === "string" ? (o["HEAD"] as string) : undefined,
        branch: typeof rawBranch === "string" ? rawBranch.replace("refs/heads/", "") : null,
        bare: !!o["bare"],
        detached: !!o["detached"],
        prunable: !!o["prunable"],
      };
    })
    .filter((w) => w.path);
}

export async function mainRepoOf(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const common = await gitAsync(["rev-parse", "--path-format=absolute", "--git-common-dir"], path);
  if (!common) return null;
  return common.endsWith("/.git") ? common.slice(0, -5) : dirname(common);
}

export async function defaultBranch(repo: string): Promise<string | null> {
  const head = await gitAsync(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], repo);
  if (head?.startsWith("refs/remotes/")) return head.slice("refs/remotes/".length);
  if (head?.startsWith("refs/heads/")) return head.slice("refs/heads/".length);
  if (head) return head;
  for (const branch of ["main", "master"]) {
    if (await gitAsync(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo)) return branch;
  }
  return null;
}

function baseRef(base: string): string {
  if (base.startsWith("refs/")) return base;
  if (base.startsWith("origin/")) return `refs/remotes/${base}`;
  if (base === "main" || base === "master") return `refs/heads/${base}`;
  return base;
}

// per-scan memo for the per-repo reads every cleanup repeats, never module-global:
// store the promise before awaiting it, so concurrent cleanups share the same fork too.
function memo<T>(ctx: Partial<Ctx>, key: string, fn: () => Promise<T>): Promise<T> {
  const cache = (ctx.cache ??= new Map<string, unknown>());
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key) as Promise<T>;
}

export const cachedDefaultBranch = (ctx: Partial<Ctx>, repo: string): Promise<string | null> =>
  memo(ctx, `base ${repo}`, () => defaultBranch(repo));

export const cachedMerged = (ctx: Partial<Ctx>, repo: string, base: string | null): Promise<Set<string>> =>
  memo(ctx, `merged ${repo} ${base}`, () => mergedBranches(repo, base));

export const cachedWorktrees = (ctx: Partial<Ctx>, repo: string): Promise<string> =>
  memo(ctx, `worktrees ${repo}`, async () => (await gitAsync(["worktree", "list", "--porcelain"], repo)) || "");

export const cachedRemotes = (ctx: Partial<Ctx>, repo: string): Promise<string[]> =>
  memo(ctx, `remotes ${repo}`, async () => ((await gitAsync(["remote"], repo)) || "").split("\n").filter(Boolean));

// branch's display names can collide with real branch names, so list exact refs once
// per repo instead of parsing git branch's shortened output
export async function mergedBranches(repo: string, base: string | null): Promise<Set<string>> {
  if (!base) return new Set();
  const out = await gitAsync(["for-each-ref", "--merged", baseRef(base), "refs/heads", "--format=%(refname:lstrip=2)"], repo);
  if (out === null) return new Set();
  return new Set(out.split("\n").filter(Boolean));
}

export interface BranchRef {
  branch: string;
  timestamp: string;
  upstream: string;
  track: string;
  remoteref: string;
  ahead: number | null;
}

function aheadCount(upstream: string, track: string): number | null {
  if (!upstream || track === "[gone]") return null;
  const ahead = track.match(/\[ahead (\d+)(?:, behind \d+)?\]/)?.[1];
  if (ahead) return Number(ahead);
  if (!track || /^\[behind \d+\]$/.test(track)) return 0;
  return null;
}

export const cachedBranchRefs = (ctx: Partial<Ctx>, repo: string): Promise<BranchRef[]> =>
  memo(ctx, `branch refs ${repo}`, async () => {
    const out = await gitAsync([
      "for-each-ref",
      "refs/heads",
      // a colliding tag makes refname:short print heads/<name>, lstrip keeps branch names exact
      "--format=%(refname:lstrip=2)%09%(committerdate:unix)%09%(upstream:short)%09%(upstream:track)%09%(upstream:remoteref)",
    ], repo);
    if (!out) return [];
    return out.split("\n").flatMap((line) => {
      const fields = line.split("\t");
      if (fields.length !== 5) return [];
      const [branch, timestamp, upstream, track, remoteref] = fields;
      if (!branch) return [];
      const upstreamName = upstream ?? "";
      const trackState = track ?? "";
      return [{ branch, timestamp: timestamp ?? "", upstream: upstreamName, track: trackState, remoteref: remoteref ?? "", ahead: aheadCount(upstreamName, trackState) }];
    });
  });

// git branch merged misses squash merges, the squashed commit has a different hash.
// replay the branch tree as a single commit on the merge base and ask git if that patch is already upstream.
// ponytail: writes one loose commit object per check, gc collects it
export async function isContentMerged(
  repo: string,
  branch: string,
  base: string | null,
  merged: Set<string> | null = null,
  ctx?: Partial<Ctx>,
): Promise<boolean> {
  if (!base || !branch) return false;
  if ((merged ?? await mergedBranches(repo, base)).has(branch)) return true;
  const branchRef = `refs/heads/${branch}`;
  const mergeBaseRef = baseRef(base);
  const [mergeBase, tree] = await Promise.all([
    gitAsync(["merge-base", mergeBaseRef, branchRef], repo),
    gitAsync(["rev-parse", `${branchRef}^{tree}`], repo),
  ]);
  if (!mergeBase || !tree) return false;
  const mergeBaseTree = ctx
    ? await memo(ctx, `merge-base tree ${repo} ${mergeBase}`, () => gitAsync(["rev-parse", `${mergeBase}^{tree}`], repo))
    : await gitAsync(["rev-parse", `${mergeBase}^{tree}`], repo);
  if (tree === mergeBaseTree) return true;
  const probe = await gitAsync(["commit-tree", tree, "-p", mergeBase, "-m", "toupeira-probe"], repo);
  if (!probe) return false;
  return (await gitAsync(["cherry", mergeBaseRef, probe], repo) || "").startsWith("-");
}

export async function unpushed(repo: string, branch: string, ctx?: Partial<Ctx>): Promise<number | null> {
  const refs = await cachedBranchRefs(ctx ?? {}, repo);
  return refs.find((ref) => ref.branch === branch)?.ahead ?? null;
}
