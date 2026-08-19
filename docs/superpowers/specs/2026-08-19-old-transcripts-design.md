# Old chat transcripts, project still here

## Problem

`session-orphan` removes per-project state once the project is gone. Nothing
touches transcripts of projects that are still here, and that is where the disk
actually goes: on the author's machine `~/.claude/projects` holds 1.1 GB and
`~/.codex/sessions` 65 MB, none of it reachable by any current category.

## Category

`transcript-old` — "old chats, project still here". One item per
`(harness, project)`, not per file: a per-file listing is thousands of rows in
the picker for no added control.

`safe: false`. A deleted transcript does not come back and `--resume` loses the
session, so it arrives unselected, marked `!`, and `--yes` never takes it. Same
treatment as `worktree-stale`, which is also real loss.

Age comes from file mtime, which rises again when a session is resumed, and from
`--days` (default 7) — the same flag worktrees use. A separate `--chat-days` is
not worth a second axis until someone wants worktrees and chats to disagree.

## Scope

claude-code and codex. Both write `.jsonl` whose header carries `cwd`, so
`headMatch(file, CWD_RE)` attributes both — codex nests it under `payload`, which
the regex does not care about. Grouping by the recorded `cwd` rather than by
directory is what makes codex's date-partitioned layout fall out for free.

gemini, cursor and crush total 6.5 MB between them: not worth a line of code.

Two files are skipped, never removed:

- `cwd` unreadable — an unattributable transcript is not deleted.
- `cwd` gone — that is `session-orphan`'s item, and it takes the whole directory.

## What removal means

`item.path` is the project directory: a real repository that must survive. It is
there for display, the size sort and dedupe. The files to remove live in
`action.files`.

Three things keep that from becoming a foot-gun:

- the action is `tree: false`,
- `remove()` rejects the whole item unless every entry in `action.files` ends in
  `.jsonl` *and* sits under `action.root` (its own harness directory),
- the guard runs in `remove()`, outside the `ACTIONS` table, like the existing
  `guard` check.

## Measurement

`item.path` was previously both "what gets deleted" and "what gets measured".
Those come apart here, so both size paths read one helper:

```js
targets(item) = item.action.files ?? [item.path]
```

`scan()` measures the union of every item's targets and sums per item;
`combinedSize` in `index.js` gets the same flattened list. `diskUsage` grows a
`statSync` fast path for plain files — thousands of transcripts must not become
thousands of `du` forks.

## Test

One fake `HOME`: an old chat for a live project, a fresh chat, and an old chat
for a project that is gone. Expect one item, `safe: false`, sized to the old file
alone. Plus: `remove()` refuses a `files` entry outside `action.root`.
