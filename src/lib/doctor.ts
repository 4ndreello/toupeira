import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { diskUsage } from "./sh.js";

function realDocker(): string | null {
  try {
    return execFileSync("docker", ["system", "df"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// well known rot, measured and shown, never offered for removal
const SPOTS: { name: string; dir: string }[] = [
  { name: "gradle caches", dir: ".gradle/caches" },
  { name: "maven repository", dir: ".m2/repository" },
  { name: "go modules", dir: ".go/pkg/mod" },
  { name: "go modules", dir: "go/pkg/mod" },
  { name: "cargo registry", dir: ".cargo/registry" },
  { name: "pip cache", dir: ".cache/pip" },
  { name: "huggingface hub", dir: ".cache/huggingface/hub" },
  { name: "torch hub", dir: ".cache/torch" },
  { name: "electron cache", dir: ".cache/electron" },
  { name: "node-gyp cache", dir: ".cache/node-gyp" },
  { name: "trash", dir: ".local/share/Trash/files" },
];

// xcode and the simulators only exist where darwin does; elsewhere the paths would be noise
const DARWIN_SPOTS: { name: string; dir: string }[] = [
  { name: "xcode derived data", dir: "Library/Developer/Xcode/DerivedData" },
  { name: "ios simulator devices", dir: "Library/Developer/CoreSimulator/Devices" },
];

export interface DoctorRow {
  name: string;
  path: string;
  size: number;
}

// ponytail: this spot list is static, the upgrade path is discovering more from each tool own config
export function report({ home, runDocker = realDocker }: { home: string; runDocker?: () => string | null }): { rows: DoctorRow[]; docker: string | null } {
  const spots = process.platform === "darwin" ? [...SPOTS, ...DARWIN_SPOTS] : SPOTS;
  const live = spots.map((s) => ({ name: s.name, path: join(home, s.dir) })).filter((s) => existsSync(s.path));
  const sizes = diskUsage(live.map((s) => s.path));
  const rows = live.map((s) => ({ ...s, size: sizes.get(s.path) ?? 0 })).sort((a, b) => b.size - a.size);
  let docker: string | null = null;
  try {
    docker = runDocker();
  } catch {
    docker = null;
  }
  return { rows, docker };
}
