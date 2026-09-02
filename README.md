# toupeira

```
        _____
       \"_   _"/        ┌┬┐ ┌─┐ ┬ ┬ ┌─┐ ┌─┐ ┬ ┬─┐ ┌─┐
       |(>)-(<)|         │  │ │ │ │ ├─┘ ├┤  │ ├┬┘ ├─┤
    ../  " O "  \..      ┴  └─┘ └─┘ ┴   └─┘ ┴ ┴└─ ┴ ┴
~~""(((:-.,_,.-:)))""~~~~~~~~~~~~~~~~~~~~~~~~~
```

[![npm](https://img.shields.io/npm/v/toupeira?color=cb3837&logo=npm)](https://www.npmjs.com/package/toupeira)
[![node](https://img.shields.io/node/v/toupeira)](https://www.npmjs.com/package/toupeira)
[![license](https://img.shields.io/npm/l/toupeira)](LICENSE)

Coding agents leave things behind: git worktrees whose PR merged weeks ago, a
full `node_modules` inside each one, session logs for projects that no longer
exist, and a pile of caches next to them — every image you ever pasted, every
shell snapshot, every undo history. `toupeira` finds them and removes them.

```
npx toupeira          # scan, read-only
npx toupeira clean    # pick what goes, then confirm
npx toupeira help     # the flags, nothing else
```

## Install

`npx` is enough — nothing is installed and the scan is read-only. Install it
only if you run it often:

```
npm install -g toupeira
toupeira
```

Node >= 20, no dependencies. Published as [`toupeira`](https://www.npmjs.com/package/toupeira) on npm.

## The scan

`scan` answers how much and roughly where, in a fixed handful of lines. It only
lists candidates whose measured targets are larger than 0 B. The per-item detail
lives in the picker:

```
20 repo(s) · 273 item(s) · 5.1 GB reclaimable

  merged worktrees                     13   3.2 GB  ━━━━━━━━━━━━
  node_modules inside a worktree        3   2.4 GB  ━━━━━━━━━
  idle worktrees, not merged            2   1.6 GB  ━━━━━━
  old chats, project still here        24   789 MB  ━━━
  caches and history outside projects   8   123 MB
  sessions for projects that are gone 231    88 MB
  6 held back, not removable — `toupeira clean` shows why
```

Maintenance-only candidates, such as stale worktree registrations, deleted
branches and package-store pruning, are omitted when toupeira cannot measure
any bytes to reclaim.

## The picker

`clean` opens a full-screen list, categories collapsed:

<img width="814" height="367" alt="image" src="https://github.com/user-attachments/assets/2ea7fdff-990f-4175-8d4c-ee26d81b485d" />

↑↓ move, ←→ collapse/expand, space toggles an item or a whole category,
`a` toggles everything, enter applies, `q` leaves. `hjkl`, `g`/`G`, page up/down
and escape work too. `[~]` means a category is partly selected; `!` marks an
item that needs a look before it goes. Old chats and caches print their age
range (`oldest 40d - newest 12d`) in a column of their own — the worktree
categories leave it blank. The headline total is deduplicated across hardlinks; the live
"sum" is a plain total, so it reads higher when worktrees share a package
store.

## How it finds your repos

It doesn't crawl your disk and it has no config file. Every agent already
writes down where it worked, so toupeira reads that, resolves each path to its
main repository, and lets `git worktree list` report the rest — including
worktrees parked in `/tmp` or under another agent's directory.

| harness | where it records the working directory | per-project state |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` | `~/.claude/projects/<path>` |
| Codex | `~/.codex/sessions/**/*.jsonl` | — (partitioned by date) |
| Gemini CLI | `~/.gemini/tmp/<name>/.project_root` | `~/.gemini/tmp/<name>` |
| Cursor | `~/.cursor/projects/<path>` | `~/.cursor/projects/<path>` |
| Crush | `~/.local/share/crush/projects.json` | — |
| Copilot CLI | `~/.copilot/session-state/**/*.jsonl` | — (partitioned by session) |
| T3 Code | `~/.t3/worktrees/<repo>/<branch>` | — (chats live in sqlite) |
| OpenCode | — (chats live in sqlite) | — |
| Cline | — (tasks keyed by opaque id) | — |
| Roo Code | — (tasks keyed by opaque id) | — |

Harnesses with per-project state also get their orphan directories reported
once the project they belong to is gone. Claude Code and Codex write one
`.jsonl` per session with the working directory in its header, so their aged
transcripts are reported as well — grouped by project, and only while that
project is still there. Chats for a project that is gone belong to the orphan
row above, which takes the whole directory instead.

## The caches

Agents also keep derived state outside your projects, and nothing ever prunes it.
`toupeira` thins these directories entry by entry, once an entry has been idle
for `--days`; the directory itself always stays.

| harness | directory | what it holds | offered by default |
| --- | --- | --- | --- |
| Claude Code | `image-cache`, `paste-cache` | every image and text you pasted | yes |
| Claude Code | `shell-snapshots`, `debug`, `jobs`, `backups` | tooling leftovers | yes |
| Claude Code | `file-history` | per-session undo history for edited files | no |
| Claude Code | `transcripts` | cloud chats, no working directory recorded | no |
| Codex | `shell_snapshots`, `log` | tooling leftovers | yes |
| T3 Code | `caches`, `userdata/logs` | provider status cache, server logs | yes |

An entry is one file (a paste) or one directory (a session's images), and its
own mtime decides: a session directory holding one fresh file counts as fresh
and stays. What is not offered by default still shows in the picker, marked `!`.

## Beyond the agents

The same scan reports developer junk no agent wrote, but every machine grows:

| category | what it offers | offered by default |
| --- | --- | --- |
| superseded test-runner browser builds | a playwright or puppeteer build with a newer one of its own kind already installed, idle for `--days` | yes |
| toolchain versions no known project pins | an nvm or pyenv version no discovered repo asks for, that is neither the newest install nor the manager's default | no |

## What it will not touch

- your main checkout, ever
- a worktree with uncommitted changes
- a worktree holding commits you never pushed
- a branch with no upstream, where the commits exist nowhere else
- your default branch, whatever its tracking config says
- the newest toolchain version, or the one your version manager calls default — and
  no version at all when that default names a moving target like `lts/*` or `node`,
  because then the daily driver cannot be identified
- a browser build with nothing newer of its own kind installed: a headless shell is
  not a browser and never supersedes one
- the project a chat belongs to — only the transcript files ever go, and a chat
  is never selected by default, because deleting one loses that session for good
- a cache directory itself, only the idle entries inside it — and undo history
  and cloud chats are never selected by default

## Merged means merged

`git branch --merged` misses squash merges — the squashed commit has a
different hash, so git swears the branch is unmerged. toupeira replays the
branch as one commit on its merge base and asks `git cherry` whether that patch
is already upstream, so squash-merged worktrees are correctly identified as
merged. Branch refs have no measured disk target, so they stay hidden from the
scan and picker.

## Flags

```
--days <n>   minimum idle age for a worktree, a chat or a cache entry
             (default 7)
--root <p>   extra repository, for agents that leave no session log
--yes        remove everything marked safe, no prompt
```

Removals are logged to `~/.local/state/toupeira/operations.log`.

The mole face is adapted from a piece signed `sjw` in the public ASCII art
collections.
