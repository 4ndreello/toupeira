import { homedir } from 'node:os'

export const HOME = homedir()
export const DAY = 86400_000

export function human(bytes) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`
}

export function short(p) {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p
}

export function elapsed(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}
