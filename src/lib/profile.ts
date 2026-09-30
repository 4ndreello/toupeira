// opt-in profiling for learning and for hunting slow scans: off by default, so the
// normal path pays one env read per phase and nothing else. TOUPEIRA_PROFILE=1 (or
// --profile) prints one stderr line per phase, =verbose also logs every git call.
export function profileEnabled(): boolean {
  const val = process.env["TOUPEIRA_PROFILE"];
  return val === "1" || val === "true" || val === "verbose" || process.argv.includes("--profile");
}

export function verboseProfile(): boolean {
  return process.env["TOUPEIRA_PROFILE"] === "verbose";
}

const counts = new Map<string, number>();

// reset is for tests only: counts live for the whole scan in real use
export function resetCounts(): void {
  counts.clear();
}

export function count(name: string, n = 1): void {
  if (!profileEnabled()) return;
  counts.set(name, (counts.get(name) ?? 0) + n);
}

// sync fast path, async phases settle before the line prints: some scan phases yield
// to the event loop now, so a sync-only timer would report ~0ms for them
export function timed<T>(label: string, fn: () => T): T {
  if (!profileEnabled()) return fn();
  const t0 = performance.now();
  const done = (): void => {
    process.stderr.write(`prof ${label} ${(performance.now() - t0).toFixed(1)} ms\n`);
  };
  const out = fn();
  if (out instanceof Promise) return (out as Promise<unknown>).finally(done) as T;
  done();
  return out;
}

// one summary block at the end of the scan, stderr so piped output stays clean
export function reportCounts(): void {
  if (!profileEnabled()) return;
  for (const [name, n] of [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) process.stderr.write(`prof count ${name} ${n}\n`);
}
