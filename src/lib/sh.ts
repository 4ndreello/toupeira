import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

export function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64e6 }).trim();
  } catch {
    return null;
  }
}

function du(args: string[]): string {
  try {
    return execFileSync("du", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64e6 });
  } catch (e) {
    const err = e as { stdout?: string };
    return err.stdout || "";
  }
}

// -k, not gnu b: bsd du on macos has no b and exits with illegal option, which used to
// zero every directory size and the whole headline. kibibytes are posix, so both agree.
const KB = 1024;

// one du per path, on purpose: a single batched call counts a hardlinked file only for
// whichever path reaches it first, so pnpm and bun worktrees report near zero at random.
// ponytail: block granularity, a directory of tiny files rounds up per file, per platform
export function diskUsage(paths: string[], onProgress: (msg: string) => void = () => {}): Map<string, number> {
  const sizes = new Map<string, number>();
  let n = 0;
  for (const p of paths) {
    onProgress(`measuring ${++n}/${paths.length}`);
    // a single file is one stat, not one fork: transcripts arrive by the thousand
    const st = statSync(p, { throwIfNoEntry: false });
    if (st?.isFile()) {
      sizes.set(p, st.size);
      continue;
    }
    const m = du(["-sk", "--", p]).match(/^(\d+)\t/);
    sizes.set(p, m?.[1] ? Number(m[1]) * KB : 0);
  }
  return sizes;
}

// combined total, deduped: what the disk actually gets back if all of these go
export function combinedSize(paths: string[]): number {
  const live = paths.filter((p) => existsSync(p));
  if (!live.length) return 0;
  let total = 0;
  for (let i = 0; i < live.length; i += 200) {
    const out = du(["-sck", "--", ...live.slice(i, i + 200)]);
    const m = out.match(/^(\d+)\ttotal$/m);
    total += m?.[1] ? Number(m[1]) * KB : 0;
  }
  return total;
}
