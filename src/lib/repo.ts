import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { git } from "./sh.js";
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

export function mainRepoOf(path: string): string | null {
  if (!existsSync(path)) return null;
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], path);
  if (!common) return null;
  return common.endsWith("/.git") ? common.slice(0, -5) : dirname(common);
}

export function defaultBranch(repo: string): string | null {
  const head = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo);
  if (head) return head;
  for (const b of ["main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", b], repo)) return b;
  }
  return null;
}

// per-scan memo for the per-repo reads every cleanup repeats, never module-global:
// parallel scans and tests must not share state. a missing cache (partial ctx in
// tests) still works, it just shares nothing.
function memo<T>(ctx: Partial<Ctx>, key: string, fn: () => T): T {
  const cache = (ctx.cache ??= new Map<string, unknown>());
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key) as T;
}

export const cachedDefaultBranch = (ctx: Partial<Ctx>, repo: string): string | null =>
  memo(ctx, `base ${repo}`, () => defaultBranch(repo));

export const cachedMerged = (ctx: Partial<Ctx>, repo: string, base: string | null): Set<string> =>
  memo(ctx, `merged ${repo} ${base}`, () => mergedBranches(repo, base));

export const cachedWorktrees = (ctx: Partial<Ctx>, repo: string): string =>
  memo(ctx, `worktrees ${repo}`, () => git(["worktree", "list", "--porcelain"], repo) || "");

export const cachedRemotes = (ctx: Partial<Ctx>, repo: string): string[] =>
  memo(ctx, `remotes ${repo}`, () => (git(["remote"], repo) || "").split("\n").filter(Boolean));

// git branch merged is per repo work, so a caller looping over every branch
// reads it once and passes the set in, otherwise it forks a full history walk per branch
export function mergedBranches(repo: string, base: string | null): Set<string> {
  if (!base) return new Set();
  const out = git(["branch", "--merged", base], repo);
  if (out === null) return new Set();
  return new Set(out.split("\n").map((l) => l.replace(/^[*+]?\s*/, "")).filter(Boolean));
}

// git branch merged misses squash merges, the squashed commit has a different hash.
// replay the branch tree as a single commit on the merge base and ask git if that patch is already upstream.
// ponytail: writes one loose commit object per check, gc collects it
export function isContentMerged(repo: string, branch: string, base: string | null, merged: Set<string> | null = null): boolean {
  if (!base || !branch) return false;
  if ((merged ?? mergedBranches(repo, base)).has(branch)) return true;
  const mergeBase = git(["merge-base", base, branch], repo);
  const tree = git(["rev-parse", `${branch}^{tree}`], repo);
  if (!mergeBase || !tree) return false;
  if (tree === git(["rev-parse", `${mergeBase}^{tree}`], repo)) return true;
  const probe = git(["commit-tree", tree, "-p", mergeBase, "-m", "toupeira-probe"], repo);
  if (!probe) return false;
  return (git(["cherry", base, probe], repo) || "").startsWith("-");
}

export function unpushed(repo: string, branch: string): number | null {
  const upstream = git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], repo);
  if (!upstream) return null;
  const n = git(["rev-list", "--count", `${upstream}..${branch}`], repo);
  return Number(n || 0);
}
