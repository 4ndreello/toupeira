import { readFileSync } from "node:fs";

// the face is 7 bit ascii on purpose: it survives any terminal.
// the wordmark is box drawing, so it only prints under a utf8 locale.
const FACE: string[] = String.raw`
        _____
       \"_   _"/
       |(>)-(<)|
    ../  " O "  \..`.split("\n").slice(1);

const WORD: string[] = ["┌┬┐ ┌─┐ ┬ ┬ ┌─┐ ┌─┐ ┬ ┬─┐ ┌─┐", " │  │ │ │ │ ├─┘ ├┤  │ ├┬┘ ├─┤", " ┴  └─┘ └─┘ ┴   └─┘ ┴ ┴└─ ┴ ┴"];
const GROUND = '~~""(((:-.,_,.-:)))""';

export const MARK = "(>)-(<)";

export const utf8 = (): boolean => /UTF-?8/i.test(process.env["LC_ALL"] || process.env["LC_CTYPE"] || process.env["LANG"] || "");

// version lives in package.json one level above dist, read at runtime so src stays
// self contained and dist ships without src. falls back when the file is absent.
function pkgVersion(): string {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// the logo stays up while the scan runs, with the progress line reading as underground
export function loadingScreen(out: NodeJS.WriteStream = process.stdout): (msg: string) => void {
  if (!out.isTTY) return () => {};
  const spin: string[] = utf8() ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] : ["-", "\\", "|", "/"];
  const cols = (out as NodeJS.WriteStream & { columns?: number }).columns;
  out.write(`\n${banner(cols).join("\n")}\n\n`);
  let tick = 0;
  return (msg: string) => {
    const frame: string = spin[tick++ % spin.length] ?? "-";
    out.write(`\x1b[2K   ${frame} ${msg}\r`);
  };
}

export function banner(cols?: number): string[] {
  const room: number = cols || process.stdout.columns || 80;
  const word: string[] = utf8() ? WORD : ["", "toupeira", ""];
  const ver = `v${pkgVersion()}`;
  const first: string = FACE[0] ?? "";
  const lines: string[] = FACE.map((f, n) => (n === 0 ? f : `${f.padEnd(24)}${word[n - 1] ?? ""}`.trimEnd()));
  void first;
  const w: number = Math.max(...lines.map((l) => l.length), GROUND.length + ver.length + 1);
  if (room < w) return ["toupeira"];
  const ground = GROUND + "~".repeat(w - GROUND.length - ver.length - 1) + " " + ver;
  return [...lines, ground];
}
