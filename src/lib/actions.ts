import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { git } from "./sh.js";
import type { Item } from "../types.js";

// Adding an action is one entry here.
//
//   tree   this action deletes the whole directory, so any item found beneath it
//          is already covered and gets deduped away by scan()
//   frees  false when the target is not a path at all (a ref, a tool own prune), so
//          scan() measures nothing for it, see targets()
//   run    performs the removal, returns whether it happened

interface ActionDef {
  tree: boolean;
  frees?: boolean;
  run: (item: Item) => boolean;
}

export const ACTIONS: Record<string, ActionDef> = {
  prune: { tree: false, run: ({ action }) => action.kind === "prune" && git(["worktree", "prune"], action.repo) !== null },
  "worktree-remove": {
    tree: true,
    run: ({ action, path }) => action.kind === "worktree-remove" && git(["worktree", "remove", path], action.repo) !== null,
  },
  // deletes a listed set of entries, not item.path, see the guard in remove()
  "rm-files": {
    tree: false,
    run: ({ action }) => {
      if (action.kind !== "rm-files") return false;
      for (const f of action.files) rmSync(f, { recursive: true, force: true });
      return true;
    },
  },
  rm: {
    tree: true,
    run: ({ path }) => {
      rmSync(path, { recursive: true, force: true });
      return true;
    },
  },
  // the target is a ref, not a path, so remove() vets it by name instead
  "branch-delete": {
    tree: false,
    frees: false,
    run: ({ action }) => action.kind === "branch-delete" && git(["branch", "-D", action.branch], action.repo) !== null,
  },
  // runs one exact argv list, never through a shell, the cleanup tables are the only
  // place commands are written down. the tool decides what it frees, so nothing here is
  // measurable, and a missing or wedged tool must not look like a success: the timeout
  // caps a prune that hangs and the false travels back to the caller.
  command: {
    tree: false,
    frees: false,
    run: ({ action }) => {
      if (action.kind !== "command") return false;
      try {
        const first: string | undefined = action.cmd[0];
        if (!first) return false;
        execFileSync(first, action.cmd.slice(1), { stdio: "ignore", timeout: 5 * 60_000 });
        return true;
      } catch {
        return false;
      }
    },
  },
};

export function remove(item: Item): boolean {
  const action = ACTIONS[item.action.kind];
  if (!action) return false;
  // checked out here, not inside the table, so a new action cannot forget it
  if ("guard" in item.action && item.action.guard && !item.path.includes(item.action.guard)) {
    throw new Error(`refused, outside its category: ${item.path}`);
  }
  // a file list is guarded per entry: item.path is a live project or a cache
  // directory, never the target. ext narrows it further where the category has one
  if ("files" in item.action) {
    for (const f of item.action.files ?? []) {
      if (!f.startsWith(`${item.action.root}/`) || (item.action.ext && !f.endsWith(item.action.ext))) {
        throw new Error(`refused, outside its category: ${f}`);
      }
    }
  }
  // git branch -D would happily eat head, option looking names, range tricks or a
  // lock file, and the path guard above cannot see the ref name, vet it here
  if (item.action.kind === "branch-delete") {
    const b: unknown = item.action.branch;
    const ok =
      typeof b === "string" &&
      /^[A-Za-z0-9._/-]+$/.test(b) &&
      !b.startsWith("-") &&
      !b.includes("..") &&
      !b.endsWith(".lock") &&
      b !== "HEAD";
    if (!ok) throw new Error(`refused, unsafe branch name: ${String(b)}`);
  }
  // a command runs by basename through path, never a path, and no argument may
  // smuggle a null byte past the exec, the argv comes from a cleanup table,
  // but remove() trusts nothing it has not vetted itself
  if (item.action.kind === "command") {
    const c: unknown = item.action.cmd;
    const ok =
      Array.isArray(c) &&
      c.length > 0 &&
      c.every((a) => typeof a === "string" && a && !a.includes("\0")) &&
      typeof (c as string[])[0] === "string" &&
      !((c as string[])[0] as string).includes("/");
    if (!ok) throw new Error("refused, malformed command");
  }
  return action.run(item);
}
