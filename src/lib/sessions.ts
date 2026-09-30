import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export const CWD_RE = /"cwd":"([^"]+)"/;

const HEAD_READ_BYTES = 4 * 1024;
const DEFAULT_HEAD_BYTES = 256 * 1024;
// only bytes read are decoded, so the shared scratch buffer need not be zero-filled
const HEAD_BUFFER = Buffer.allocUnsafe(DEFAULT_HEAD_BYTES);

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
export function headMatch(file: string, re: RegExp, bytes = DEFAULT_HEAD_BYTES): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = bytes > HEAD_BUFFER.length ? Buffer.allocUnsafe(bytes) : HEAD_BUFFER;
    const firstSize = Math.min(HEAD_READ_BYTES, bytes);
    let n = readSync(fd, buf, 0, firstSize, 0);
    let m = buf.subarray(0, n).toString("utf8").match(re);
    // re must use a delimiter the value cannot contain, so crossing values need the second read
    if (!m && n < bytes && (n === firstSize || fstatSync(fd).size > n)) {
      n += readSync(fd, buf, n, bytes - n, n);
      m = buf.subarray(0, n).toString("utf8").match(re);
    }
    return m?.[1] ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // cleanup failure must not replace the null-on-error result
      }
    }
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
