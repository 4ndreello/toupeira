import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export const CWD_RE = /"cwd":"([^"]+)"/;

export function walkFiles(root: string, depth: number, ext: string, out: string[] = []): string[] {
  if (depth < 0 || !existsSync(root)) return out;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) walkFiles(p, depth - 1, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

export function entryNames(root: string): string[] {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
}

export function dirNames(root: string): string[] {
  return entryNames(root).filter((n) => {
    try {
      return statSync(join(root, n)).isDirectory();
    } catch {
      return false;
    }
  });
}

// session transcripts run to hundreds of mb; cwd is in the header, so read the head only
export function headMatch(file: string, re: RegExp, bytes = 256 * 1024): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    const m = buf.subarray(0, n).toString("utf8").match(re);
    return m?.[1] ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// every working directory recorded in the jsonl transcripts under root
export function jsonlCwds(root: string, depth: number): string[] {
  const out: string[] = [];
  for (const f of walkFiles(root, depth, ".jsonl")) {
    const cwd = headMatch(f, CWD_RE);
    if (cwd) out.push(cwd);
  }
  return out;
}

export interface DecodedDir {
  path: string;
  exists: boolean;
  matched: number;
}

// project dir names encode slash as dash, which is lossy: /a/b-c and /a-b/c collide.
// walk the real filesystem and take the longest existing child at each level.
// matched counts the segments that resolved: 0 means the name is not an encoded
// path at all (an agent scratch dir like empty-window), not a project that vanished.
// ponytail: greedy, no backtracking, enough to tell this path is gone from this path is here
export function decodeProjectDir(name: string, exists: (p: string) => boolean = existsSync): DecodedDir {
  const segs: string[] = name.replace(/^-/, "").split("-");
  let cur = "";
  let i = 0;
  while (i < segs.length) {
    let next: { cand: string; j: number } | null = null;
    for (let j = segs.length; j > i; j--) {
      const cand = `${cur}/${segs.slice(i, j).join("-")}`;
      if (exists(cand)) {
        next = { cand, j };
        break;
      }
    }
    if (!next) return { path: `${cur}/${segs.slice(i).join("-")}`, exists: false, matched: i };
    cur = next.cand;
    i = next.j;
  }
  return { path: cur, exists: true, matched: i };
}
