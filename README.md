# toupeira

```
        _____
       \"_   _"/        ┌┬┐ ┌─┐ ┬ ┬ ┌─┐ ┌─┐ ┬ ┬─┐ ┌─┐
       |(>)-(<)|         │  │ │ │ │ ├─┘ ├┤  │ ├┬┘ ├─┤
    ../  " O "  \..      ┴  └─┘ └─┘ ┴   └─┘ ┴ ┴└─ ┴ ┴
~~""(((:-.,_,.-:)))""~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
```

Coding agents leave things behind: git worktrees whose PR merged weeks ago, a
full `node_modules` inside each one, and session logs for projects that no
longer exist. `toupeira` finds them and removes them.

```
npx toupeira          # scan, read-only
npx toupeira clean    # pick what goes, then confirm
```

## The picker

`clean` opens a full-screen list, categories collapsed:

<img width="814" height="367" alt="image" src="https://github.com/user-attachments/assets/2ea7fdff-990f-4175-8d4c-ee26d81b485d" />

↑↓ move, ←→ collapse/expand, space toggles an item or a whole category,
`a` toggles everything, enter applies, `q` leaves. `[~]` means a category is
partly selected; `!` marks an item that needs a look before it goes. The
headline total is deduplicated across hardlinks; the live "sum" is a plain
total, so it reads higher when worktrees share a package store.

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
once the project they belong to is gone.

## What it will not touch

- your main checkout, ever
- a worktree with uncommitted changes
- a worktree holding commits you never pushed
- a branch with no upstream, where the commits exist nowhere else

## Merged means merged

`git branch --merged` misses squash merges — the squashed commit has a
different hash, so git swears the branch is unmerged. toupeira replays the
branch as one commit on its merge base and asks `git cherry` whether that patch
is already upstream, so squash-merged worktrees are correctly reported as gone.

## Flags

```
--days <n>   minimum idle age to consider a worktree stale (default 7)
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
