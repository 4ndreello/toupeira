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

```
(>)-(<) toupeira · 20 repos · 4.3 GB reclaimable · 251 selected, sum 5.7 GB

▶ [x] merged worktrees                  ━━━━━━━━━━━━ 3.2 GB    13 item(s)
▶ [x] node_modules inside a worktree    ━━━━━━━━━    2.4 GB     3 item(s)
▶ [ ] idle worktrees, not merged        ━━━━━━       1.6 GB     2 item(s)
▶ [x] sessions for projects that are gone            88 MB    231 item(s)
▶ [x] stale worktree registrations                    0 B       4 item(s)
```

↑↓ move, ←→ collapse/expand, space toggles an item or a whole category,
`a` toggles everything, enter applies, `q` leaves. `[~]` means a category is
partly selected; `!` marks an item that needs a look before it goes. The
headline total is deduplicated across hardlinks; the live "sum" is a plain
total, so it reads higher when worktrees share a package store.

## How it finds your repos

It doesn't crawl your disk and it has no config file. Claude Code and Codex
write the working directory into every session log, so toupeira reads that,
resolves each path to its main repository, and lets `git worktree list` report
the rest — including worktrees parked in `/tmp` or under another agent's
directory.

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

The mole face is adapted from a piece signed `sjw` in the public ASCII art
collections.
