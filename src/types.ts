export type ActionKind =
  | { kind: "prune"; repo: string }
  | { kind: "worktree-remove"; repo: string }
  | { kind: "rm-files"; files: string[]; root: string; ext?: string }
  | { kind: "rm"; guard: string }
  | { kind: "branch-delete"; repo: string; branch: string }
  | { kind: "command"; cmd: string[] };

export interface Item {
  cat: string;
  repo: string | null;
  path: string;
  size: number;
  safe: boolean;
  note: string;
  span?: string;
  label?: string;
  action: ActionKind;
}

export interface Kept {
  path: string;
  why: string;
}

export interface Ctx {
  repos: Set<string>;
  days: number;
  home: string;
  now: number;
  onProgress: (msg: string) => void;
}

export interface CollectResult {
  items: Item[];
  kept?: Kept[];
}
