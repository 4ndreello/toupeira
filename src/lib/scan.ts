import { existsSync } from "node:fs";
import { HOME } from "./format.js";
import { diskUsage } from "./sh.js";
import { mainRepoOf } from "./repo.js";
import { harnessCwds } from "./harnesses.js";
import { CLEANUPS } from "./cleanups/index.js";
import { ACTIONS } from "./actions.js";
import type { Item } from "../types.js";

// what removing this item actually frees: its own file list, or the path itself, unless
// the action declares frees false, which means its target is not a path (a ref, a
// tool own prune) and path is display only. counting it would put a whole repository
// or a whole package store into the reclaimable headline.
export interface TargetInput {
  path: string;
  action: { kind: string; files?: string[] };
}
export const targets = (i: TargetInput): string[] =>
  i.action.files ?? (ACTIONS[i.action.kind]?.frees === false ? [] : [i.path]);

// an item that deletes a whole directory already covers anything found beneath it:
// removing a worktree takes its node_modules along, so only the worktree is listed
export function dedupe<T extends TargetInput>(items: T[]): T[] {
  const trees = items.filter((i) => ACTIONS[i.action.kind]?.tree);
  return items.filter((i) => !trees.some((o) => o !== i && i.path.startsWith(`${o.path}/`)));
}

export interface ScanResult {
  items: Item[];
  kept: { path: string; why: string }[];
  repos: number;
}

export function scan(
  { days = 7, roots = [], home = HOME, onProgress = () => {} }: { days?: number; roots?: string[]; home?: string; onProgress?: (msg: string) => void } = {},
): ScanResult {
  onProgress("reading agent sessions");
  const repos = new Set<string>();
  for (const p of [...harnessCwds(home), ...roots]) {
    const r = mainRepoOf(p);
    if (r) repos.add(r);
  }

  const ctx = { repos, days, home, now: Date.now(), onProgress };
  const items: Item[] = [];
  const kept: { path: string; why: string }[] = [];
  for (const cleanup of CLEANUPS) {
    const out = cleanup.collect(ctx);
    items.push(...out.items);
    if (out.kept) kept.push(...out.kept);
  }

  const paths = [...new Set(items.flatMap(targets))].filter((p) => existsSync(p));
  const sizes = diskUsage(paths, onProgress);
  for (const i of items) i.size = targets(i).reduce((s, p) => s + (sizes.get(p) ?? 0), 0);

  // only items with a positive measured target contribute to the reclaimable result. this
  // keeps unmeasurable actions, such as a branch ref or a tool managed prune, out of the
  // picker and out of yes.
  const final = dedupe(items).filter((i) => i.size > 0);
  final.sort((a, b) => b.size - a.size);
  return { items: final, kept, repos: repos.size };
}
