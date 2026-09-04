import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./format.js";
import { decodeProjectDir, dirNames, jsonlCwds } from "./sessions.js";

// Adding a harness is one entry in the table below.
//
//   name      shown in notes
//   cwds()    every working directory this harness has recorded, however it stores them
//   projects  optional: a directory of per project state, one subdirectory per project.
//             target(dir, name) returns the filesystem path that state belongs to, or
//             null when it cannot be determined, null is never removed.
//   transcripts optional: { dir, depth } holding .jsonl sessions whose header carries
//             cwd. grouping by that cwd is what makes a date partitioned layout work.
//   caches    optional: { root, dirs: [{ name, what, safe }] }, directories of
//             derived state, thinned entry by entry once idle. safe false means
//             it holds something you might still want (undo history, chats).

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

const firstLine = (file: string): string | null => readText(file)?.trim() || null;

function decoded(name: string): string | null {
  const r = decodeProjectDir(name);
  return r.matched ? r.path : null;
}

function projectRoots(root: string): string[] {
  return dirNames(root)
    .map((n) => firstLine(join(root, n, ".project_root")))
    .filter((v): v is string => Boolean(v));
}

function jsonPaths(file: string): string[] {
  const raw = readText(file);
  if (!raw) return [];
  try {
    return ((JSON.parse(raw) as { projects?: { path?: unknown }[] }).projects || [])
      .map((p) => p.path)
      .filter((v): v is string => typeof v === "string" && Boolean(v));
  } catch {
    return [];
  }
}

export interface Harness {
  name: string;
  cwds?: () => string[];
  projects?: { dir: string; target: (dir: string, name: string) => string | null };
  transcripts?: { dir: string; depth: number };
  caches?: { root: string; dirs: { name: string; what: string; safe: boolean }[] };
}

export function harnesses(home: string = HOME): Harness[] {
  const claude = join(home, ".claude/projects");
  const cursor = join(home, ".cursor/projects");
  const gemini = join(home, ".gemini/tmp");
  const codexHome = join(home, ".codex");
  const codex = join(codexHome, "sessions");
  // vs code keeps extension state under its user data dir; the layout inside is the
  // same everywhere, only the parent moves
  const vscodeStorage = (id: string): string =>
    process.platform === "darwin"
      ? join(home, "Library/Application Support/Code/User/globalStorage", id)
      : join(home, ".config/Code/User/globalStorage", id);
  const opencodeData = join(home, ".local/share/opencode");
  const copilot = join(home, ".copilot/session-state");
  const t3Home = join(home, ".t3");
  // one declaration per harness: discovery and transcript reading must agree on what a
  // session is, so the (dir, depth) pair is written once and used by both
  const claudeTx = { dir: claude, depth: 2 };
  const codexTx = { dir: codex, depth: 5 };
  const copilotTx = { dir: copilot, depth: 2 };
  return [
    {
      name: "claude-code",
      cwds: () => jsonlCwds(claudeTx.dir, claudeTx.depth),
      // the transcript is authoritative; the dashed directory name is a lossy fallback
      projects: { dir: claude, target: (dir: string, name: string) => jsonlCwds(dir, 2)[0] || decoded(name) },
      transcripts: claudeTx,
      caches: {
        root: join(home, ".claude"),
        dirs: [
          { name: "image-cache", what: "pasted image(s)", safe: true },
          { name: "paste-cache", what: "pasted text(s)", safe: true },
          { name: "shell-snapshots", what: "shell snapshot(s)", safe: true },
          { name: "debug", what: "debug log(s)", safe: true },
          { name: "jobs", what: "finished job(s)", safe: true },
          { name: "backups", what: "settings backup(s)", safe: true },
          { name: "file-history", what: "edit undo history", safe: false },
          { name: "transcripts", what: "cloud chat(s), no cwd recorded", safe: false },
        ],
      },
    },
    {
      name: "codex",
      cwds: () => jsonlCwds(codexTx.dir, codexTx.depth),
      // sessions are partitioned by date, not by project: nothing to orphan check
      transcripts: codexTx,
      caches: {
        root: codexHome,
        dirs: [
          { name: "shell_snapshots", what: "shell snapshot(s)", safe: true },
          { name: "log", what: "tui log(s)", safe: true },
        ],
      },
    },
    {
      name: "gemini",
      cwds: () => projectRoots(gemini),
      projects: { dir: gemini, target: (dir: string) => firstLine(join(dir, ".project_root")) },
    },
    {
      name: "cursor",
      cwds: () => dirNames(cursor).map(decoded).filter((v): v is string => Boolean(v)),
      projects: { dir: cursor, target: (_dir: string, name: string) => decoded(name) },
    },
    {
      name: "crush",
      cwds: () => jsonPaths(join(home, ".local/share/crush/projects.json")),
    },
    {
      // sessions moved into opencode.db (sqlite), so no chat can be attributed to a
      // project anymore. layout from sst/opencode packages core global and database as of 2026-08
      name: "opencode",
      caches: {
        root: opencodeData,
        dirs: [
          { name: "log", what: "log file(s)", safe: true },
          { name: "tool-output", what: "truncated tool output(s)", safe: true },
        ],
      },
    },
    {
      // task directories carry opaque ids and the workspace lives in sqlite state,
      // so only an mtime thinning is possible. layout from cline disk storage as of 2026-08
      name: "cline",
      caches: {
        root: vscodeStorage("saoudrizwan.claude-dev"),
        dirs: [{ name: "tasks", what: "old task(s)", safe: false }],
      },
    },
    {
      // same shape as cline under its own extension id. layout from roo task history store as of 2026-08
      name: "roo-code",
      caches: {
        root: vscodeStorage("rooveterinaryinc.roo-cline"),
        dirs: [{ name: "tasks", what: "old task(s)", safe: false }],
      },
    },
    {
      // one directory per session holding events.jsonl whose first event carries
      // context.cwd, so the jsonl helpers work as is. layout from the github docs
      // cli config dir reference and copilot cli discussion 324 as of 2026-08
      name: "copilot-cli",
      cwds: () => jsonlCwds(copilotTx.dir, copilotTx.depth),
      // sessions are partitioned by session id, not by project: nothing to orphan check
      transcripts: copilotTx,
    },
    {
      // workspaces are real git worktrees parked at worktrees repo branch,
      // so resolving each to its main repo feeds them into the regular worktree
      // cleanup with all of its protections intact. threads and their projects
      // live in state.sqlite, nothing else on disk carries a cwd.
      name: "t3-code",
      cwds: () => dirNames(join(t3Home, "worktrees")).flatMap((r) => dirNames(join(t3Home, "worktrees", r)).map((b) => join(t3Home, "worktrees", r, b))),
      caches: {
        root: t3Home,
        dirs: [
          { name: "caches", what: "provider status cache(s)", safe: true },
          { name: join("userdata", "logs"), what: "server log(s)", safe: true },
        ],
      },
    },
  ];
}

export function harnessCwds(home: string = HOME): Set<string> {
  const all = new Set<string>();
  // caches only harnesses record no working directory at all
  for (const h of harnesses(home)) for (const p of h.cwds?.() || []) all.add(p);
  return all;
}
