import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { count, verboseProfile } from "./profile.js";

const maxInFlight = availableParallelism();
let inFlight = 0;
const waiting: (() => void)[] = [];

export async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= maxInFlight) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    inFlight++;
  }
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
  }
}

export function gitAsync(args: string[], cwd: string): Promise<string | null> {
  return limited(() => new Promise((resolve) => {
    count("git");
    if (verboseProfile()) process.stderr.write(`prof git ${args.join(" ")}\n`);
    try {
      const child = execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 64e6 }, (error, stdout) => {
        resolve(error ? null : stdout.trim());
      });
      child.stdin?.end();
    } catch {
      resolve(null);
    }
  }));
}

function duSync(args: string[]): string {
  count("du");
  try {
    return execFileSync("du", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64e6 });
  } catch (e) {
    const err = e as { stdout?: string };
    return err.stdout || "";
  }
}

function duAsync(args: string[]): Promise<string> {
  return limited(() => new Promise((resolve) => {
    count("du");
    let stdout = "";
    try {
      const child = spawn("du", args, { stdio: ["ignore", "pipe", "ignore"] });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
      child.on("error", () => resolve(stdout));
      child.on("close", () => resolve(stdout));
    } catch {
      resolve(stdout);
    }
  }));
}

// -k, not gnu b: bsd du on macos has no b and exits with illegal option, which used to
// zero every directory size and the whole headline. kibibytes are posix, so both agree.
const KB = 1024;

// one du per path, on purpose: a single batched call counts a hardlinked file only for
// whichever path reaches it first, so pnpm and bun worktrees report near zero at random.
// ponytail: block granularity, a directory of tiny files rounds up per file, per platform
export async function diskUsage(paths: string[], onProgress: (msg: string) => void = () => {}): Promise<Map<string, number>> {
  let completed = 0;
  const progress = (): void => onProgress(`measuring ${++completed}/${paths.length}`);
  if (paths.length) onProgress(`measuring 0/${paths.length}`);
  const rows = await Promise.all(paths.map(async (p) => {
    // a single file is one stat, not one fork: transcripts arrive by the thousand
    const st = statSync(p, { throwIfNoEntry: false });
    if (st?.isFile()) {
      count("stat-file");
      progress();
      return [p, st.size] as const;
    }
    count("du-dir");
    const m = (await duAsync(["-sk", "--", p])).match(/^(\d+)\t/);
    progress();
    return [p, m?.[1] ? Number(m[1]) * KB : 0] as const;
  }));
  return new Map(rows);
}

// combined total, deduped: what the disk actually gets back if all of these go
export function combinedSize(paths: string[]): number {
  const live = paths.filter((p) => existsSync(p));
  if (!live.length) return 0;
  let total = 0;
  for (let i = 0; i < live.length; i += 200) {
    const out = duSync(["-sck", "--", ...live.slice(i, i + 200)]);
    const m = out.match(/^(\d+)\ttotal$/m);
    total += m?.[1] ? Number(m[1]) * KB : 0;
  }
  return total;
}
