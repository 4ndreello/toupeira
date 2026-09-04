import { homedir } from "node:os";

export const HOME: string = homedir();
export const DAY: number = 86400_000;

export function human(bytes: number): string {
  const u: string[] = ["B", "KB", "MB", "GB", "TB"];
  let n: number = bytes;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  const unit: string = u[i] ?? "B";
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${unit}`;
}

export function short(p: string): string {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}

export function elapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// piecewise numeric compare, missing pieces reading as 0: 131.0 ties 131
export function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d: number = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
