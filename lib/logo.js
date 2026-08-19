// the face is 7-bit ASCII on purpose: it survives any terminal.
// the wordmark is box-drawing, so it only prints under a UTF-8 locale.
const FACE = String.raw`
        _____
       \"_   _"/
       |(>)-(<)|
    ../  " O "  \..`.split('\n').slice(1)

const WORD = ['┌┬┐ ┌─┐ ┬ ┬ ┌─┐ ┌─┐ ┬ ┬─┐ ┌─┐', ' │  │ │ │ │ ├─┘ ├┤  │ ├┬┘ ├─┤', ' ┴  └─┘ └─┘ ┴   └─┘ ┴ ┴└─ ┴ ┴']
const GROUND = '~~""(((:-.,_,.-:)))""'

export const MARK = '(>)-(<)'

export const utf8 = () => /UTF-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '')

// the logo stays up while the scan runs, with the progress line reading as underground
export function loadingScreen(out = process.stdout) {
  if (!out.isTTY) return () => {}
  const spin = utf8() ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['-', '\\', '|', '/']
  out.write(`\n${banner(out.columns).join('\n')}\n\n`)
  let tick = 0
  return (msg) => out.write(`\x1b[2K   ${spin[tick++ % spin.length]} ${msg}\r`)
}

export function banner(cols) {
  const room = cols || process.stdout.columns || 80 // a terminal reporting 0 means "unknown", not "tiny"
  const word = utf8() ? WORD : ['', 'toupeira', '']
  const lines = FACE.map((f, n) => (n === 0 ? f : `${f.padEnd(24)}${word[n - 1]}`.trimEnd()))
  const w = Math.max(...lines.map((l) => l.length), GROUND.length)
  if (room < w) return ['toupeira'] // no room: the name alone beats a mangled logo
  return [...lines, GROUND + '~'.repeat(w - GROUND.length)]
}
