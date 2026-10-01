import { spawn } from "node:child_process";
import { rm as fsRm } from "node:fs/promises";
import { gitAsync, limited } from "./sh.js";
import type { Item } from "../types.js";

// Adding an action is one entry here.
//
//   tree   this action deletes the whole directory, so any item found beneath it
//          is already covered and gets deduped away by scan()
//   frees  false when the target is not a path at all (a ref, a tool own prune), so
//          scan() measures nothing for it, see targets()
//   weightless  what goes is known but weighs nothing on disk (a ref), so scan() lists
//          it at 0 B instead of hiding it with the unmeasurable prunes
//   run    performs the removal, returns whether it happened

interface ActionDef {
  tree: boolean;
  frees?: boolean;
  weightless?: boolean;
  run: (item: Item, removeFile?: FileRm) => Promise<boolean>;
}

type FileRm = (path: string, options: { recursive: true; force: true }) => Promise<void>;

function limitedRm(path: string, removeFile: FileRm): Promise<void> {
  return limited(() => removeFile(path, { recursive: true, force: true }));
}

export function runCommand(cmd: string[], timeoutMs = 5 * 60_000): Promise<boolean> {
  const [file, ...args] = cmd;
  if (!file) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const clearTimer = (): void => {
      if (timer) clearTimeout(timer);
    };
    try {
      const child = spawn(file, args, { shell: false, stdio: "ignore" });
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.once("error", () => {
        clearTimer();
        resolve(false);
      });
      child.once("close", (code) => {
        clearTimer();
        resolve(code === 0 && !timedOut);
      });
    } catch {
      clearTimer();
      resolve(false);
    }
  });
}

export const ACTIONS: Record<string, ActionDef> = {
  prune: {
    tree: false,
    run: async ({ action }) => action.kind === "prune" && (await gitAsync(["worktree", "prune"], action.repo)) !== null,
  },
  "worktree-remove": {
    tree: true,
    run: async ({ action, path }) => action.kind === "worktree-remove" && (await gitAsync(["worktree", "remove", path], action.repo)) !== null,
  },
  // deletes a listed set of entries, not item.path, see the guard in remove()
  "rm-files": {
    tree: false,
    run: async ({ action }, removeFile = fsRm) => {
      if (action.kind !== "rm-files") return false;
      for (const file of action.files) await limitedRm(file, removeFile);
      return true;
    },
  },
  rm: {
    tree: true,
    run: async ({ path }, removeFile = fsRm) => {
      await limitedRm(path, removeFile);
      return true;
    },
  },
  // the target is a ref, not a path, so remove() vets it by name instead
  "branch-delete": {
    tree: false,
    frees: false,
    weightless: true,
    run: async ({ action }) => action.kind === "branch-delete" && (await gitAsync(["branch", "-D", action.branch], action.repo)) !== null,
  },
  // runs one exact argv list, never through a shell, the cleanup tables are the only
  // place commands are written down. the tool decides what it frees, so nothing here is
  // measurable, and a missing or wedged tool must not look like a success: the timeout
  // caps a prune that hangs and the false travels back to the caller.
  command: {
    tree: false,
    frees: false,
    run: ({ action }) => action.kind === "command" ? runCommand(action.cmd) : Promise.resolve(false),
  },
};

export async function remove(item: Item): Promise<boolean> {
  const action = ACTIONS[item.action.kind];
  if (!action) return false;
  // checked out here, not inside the table, so a new action cannot forget it
  if ("guard" in item.action && item.action.guard && !item.path.includes(item.action.guard)) {
    throw new Error(`refused, outside its category: ${item.path}`);
  }
  // a file list is guarded per entry: item.path is a live project or a cache
  // directory, never the target. ext narrows it further where the category has one
  if ("files" in item.action) {
    for (const file of item.action.files ?? []) {
      if (!file.startsWith(`${item.action.root}/`) || (item.action.ext && !file.endsWith(item.action.ext))) {
        throw new Error(`refused, outside its category: ${file}`);
      }
    }
  }
  // git branch -D would happily eat head, option looking names, range tricks or a
  // lock file, and the path guard above cannot see the ref name, vet it here
  if (item.action.kind === "branch-delete") {
    const branch: unknown = item.action.branch;
    const ok =
      typeof branch === "string" &&
      /^[A-Za-z0-9._/+-]+$/.test(branch) &&
      !branch.startsWith("-") &&
      !branch.includes("..") &&
      !branch.endsWith(".lock") &&
      branch !== "HEAD";
    if (!ok) throw new Error(`refused, unsafe branch name: ${String(branch)}`);
  }
  // a command runs by basename through path, never a path, and no argument may
  // smuggle a null byte past the exec, the argv comes from a cleanup table,
  // but remove() trusts nothing it has not vetted itself
  if (item.action.kind === "command") {
    const command: unknown = item.action.cmd;
    const ok =
      Array.isArray(command) &&
      command.length > 0 &&
      command.every((arg) => typeof arg === "string" && arg && !arg.includes("\0")) &&
      typeof (command as string[])[0] === "string" &&
      !((command as string[])[0] as string).includes("/");
    if (!ok) throw new Error("refused, malformed command");
  }
  return action.run(item);
}

export interface RemoveResult {
  item: Item;
  ok: boolean;
  message?: string;
  freed: number;
}

function laneKey(item: Item): string | null {
  switch (item.action.kind) {
    case "prune":
    case "worktree-remove":
    case "branch-delete":
      return `git:${item.action.repo}`;
    case "command":
      return "command";
    default:
      return null;
  }
}

export async function removeAll(
  items: Item[],
  onResult: (result: RemoveResult) => void,
  run: (item: Item) => Promise<boolean> = remove,
): Promise<void> {
  const byLane = new Map<string, Item[]>();
  const lanes: Item[][] = [];
  for (const item of items) {
    const key = laneKey(item);
    if (key === null) {
      lanes.push([item]);
      continue;
    }
    const lane = byLane.get(key);
    if (lane) lane.push(item);
    else byLane.set(key, [item]);
  }
  // store prunes run last so they see node_modules removed by the other lanes
  const commandLane = byLane.get("command");
  byLane.delete("command");
  lanes.push(...byLane.values());

  const runLane = async (lane: Item[]): Promise<void> => {
    for (const item of lane) {
      let result: RemoveResult;
      try {
        const ok = await run(item);
        result = ok
          ? { item, ok, freed: item.size }
          : { item, ok, message: "the removal reported a failure", freed: 0 };
      } catch (error) {
        result = { item, ok: false, message: error instanceof Error ? error.message : String(error), freed: 0 };
      }
      onResult(result);
    }
  };

  await Promise.all(lanes.map(runLane));
  if (commandLane) await runLane(commandLane);
}
