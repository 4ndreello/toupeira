# toupeira

```
        _____
       \"_   _"/        ┌┬┐ ┌─┐ ┬ ┬ ┌─┐ ┌─┐ ┬ ┬─┐ ┌─┐
       |(>)-(<)|         │  │ │ │ │ ├─┘ ├┤  │ ├┬┘ ├─┤
    ../  " O "  \..      ┴  └─┘ └─┘ ┴   └─┘ ┴ ┴└─ ┴ ┴
~~""(((:-.,_,.-:)))""~~~~~~~~~~~~~~~~~~~~~~~~~ vX.Y.Z
```

[![npm](https://img.shields.io/npm/v/toupeira?color=cb3837&logo=npm)](https://www.npmjs.com/package/toupeira)
[![node](https://img.shields.io/node/v/toupeira)](https://www.npmjs.com/package/toupeira)
[![license](https://img.shields.io/npm/l/toupeira)](LICENSE)

Coding agents leave things behind: git worktrees whose PR merged weeks ago, a
full `node_modules` inside each one, and session logs for projects that no
longer exist. `toupeira` finds them and removes them.

```
npx toupeira          # scan, read-only
npx toupeira clean    # pick what goes, then confirm
npx toupeira help     # the flags, nothing else
```

## The scan

`scan` answers how much and roughly where, in a fixed handful of lines — the
per-item detail lives in the picker:

```
20 repo(s) · 277 item(s) · 5.1 GB reclaimable

  merged worktrees                     13   3.2 GB  ━━━━━━━━━━━━
  node_modules inside a worktree        3   2.4 GB  ━━━━━━━━━
  idle worktrees, not merged            2   1.6 GB  ━━━━━━
  old chats, project still here        24   789 MB  ━━━
  sessions for projects that are gone 231    88 MB
  stale worktree registrations          4     0 B

  6 held back, not removable — `toupeira clean` shows why
```

## The picker

`clean` opens a full-screen list, categories collapsed:

<img width="814" height="367" alt="image" src="https://github.com/user-attachments/assets/2ea7fdff-990f-4175-8d4c-ee26d81b485d" />

↑↓ move, ←→ collapse/expand, space toggles an item or a whole category,
`a` toggles everything, enter applies, `q` leaves. `hjkl`, `g`/`G`, page up/down
and escape work too. `[~]` means a category is partly selected; `!` marks an
item that needs a look before it goes. Old chats also print their age range
(`oldest 40d - newest 12d`) in a column of their own — the other categories
leave it blank. The headline total is deduplicated across hardlinks; the live
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

Harnesses with per-project state also get their orphan directories reported
once the project they belong to is gone. Claude Code and Codex write one
`.jsonl` per session with the working directory in its header, so their aged
transcripts are reported as well — grouped by project, and only while that
project is still there. Chats for a project that is gone belong to the orphan
row above, which takes the whole directory instead.

## What it will not touch

- your main checkout, ever
- a worktree with uncommitted changes
- a worktree holding commits you never pushed
- a branch with no upstream, where the commits exist nowhere else
- the project a chat belongs to — only the transcript files ever go, and a chat
  is never selected by default, because deleting one loses that session for good

## Merged means merged

`git branch --merged` misses squash merges — the squashed commit has a
different hash, so git swears the branch is unmerged. toupeira replays the
branch as one commit on its merge base and asks `git cherry` whether that patch
is already upstream, so squash-merged worktrees are correctly reported as gone.

## Flags

```
--days <n>   minimum idle age for a worktree or a chat to count as stale
             (default 7)
--root <p>   extra repository, for agents that leave no session log
--yes        remove everything marked safe, no prompt
```

Removals are logged to `~/.local/state/toupeira/operations.log`.

## Adding a harness or a cleanup

Three registries, all plain arrays — no plugin loader, no config file.

- **harness** — one entry in `lib/harnesses.js`: a `cwds()` returning the paths
  it recorded, and optionally a `projects` directory with a `target()` that
  says which path each subdirectory belongs to. Returning `null` from
  `target()` means "cannot tell", and nothing that cannot be told is removed.
  A `transcripts: { dir, depth }` entry opts the harness into the chat category.
- **cleanup** — one file in `lib/cleanups/` exporting `cats` (its category
  labels) and `collect(ctx)` returning `{ items, kept }`, plus one line in
  `lib/cleanups/index.js`. The picker reads labels from the registry, so no ui
  file has to be touched.
- **action** — one entry in `lib/actions.js`: `run` performs the removal, `tree`
  says whether it deletes a whole directory, which is how an item nested inside
  another gets deduped away. The path guard is enforced outside the table, so a
  new action cannot forget it.

The mole face is adapted from a piece signed `sjw` in the public ASCII art
collections.
