# Merged branches, whatever their upstream says

## Problem

Agents leave branches behind. On the author's machine, six discovered repos held
138 local branches besides the default one. Claude Code's `--worktree` leaves
`worktree-<adjective>-<noun>`, codedeck leaves `ra/<task>-<hash>`, and the
worktree goes long before the branch does, because `worktree-remove` never
deletes a ref.

`branch-gone` offered none of them, for two independent reasons:

- **The rule.** It needs a deleted upstream *and* content in the default branch
  *and* a tip older than `--days`. Of the 82 branches not checked out, 60 had
  their content in `origin/main`; 2 of those also had a gone upstream, and only
  one was old enough.
- **The filter.** `scan()` drops every item whose measured size is 0
  (`fix(scan): Hide zero-byte cleanup items`, #16). A ref frees nothing on disk,
  so even a branch that passed the rule never reached the picker. The category
  has been invisible since that change.

| state, not checked out | count | offered today |
|---|---|---|
| in main, no upstream | 38 | no |
| in main, upstream still there | 18 | no |
| in main, upstream gone or ahead | 4 | 1 passes the rule, then the filter hides it |
| pushed, not merged | 7 | no |
| ahead of upstream, not merged | 4 | no |
| no upstream, not merged | 11 | no |

## Rule

Content in the default branch is the evidence. The upstream was only ever a
proxy for "these commits exist elsewhere", and a branch whose patch is already in
`origin/main` exists elsewhere by definition.

A branch is offered, `safe: true`, when all of these hold:

1. it is not the default branch (local name, `localName` as today),
2. no worktree has it checked out, *or is rebasing it* (below),
3. `isContentMerged` says its patch is in the default branch, ancestor or squash,
4. its ref has not moved for `--days` (below).

The upstream state goes into the `note` (`origin/x deleted`, `origin/x still
there`, `never pushed`), it no longer gates anything.

Category `branch-merged`, "local branches already in the default branch". It
replaces `branch-gone`; the log line changes name, which nothing reads back.

### Age is when the ref moved, not when the tip was committed

A branch created from `main` a minute ago, before its first commit, carries
`main`'s tip date. If `main` has been quiet for a week, the branch looks a week
old and is offered while someone is about to start work on it.

Age comes from the mtime of `<common-dir>/logs/refs/heads/<branch>`: one
`statSync`, no fork. It is touched on every ref update (create, commit, reset,
rebase). With no reflog (`core.logAllRefUpdates=false`) it falls back to the tip's
committer date, which is today's behavior.

### A worktree mid-rebase hides its branch

During `git rebase`, `git worktree list --porcelain` prints the worktree as
`detached`, so the busy set misses the branch being rebased. `git branch -D` does
refuse it ("used by worktree"), so nothing is lost, but the picker would offer a
row that can only end in `✗`.

The branch under rebase is in `<gitdir>/rebase-merge/head-name` or
`<gitdir>/rebase-apply/head-name`, where `<gitdir>` is `<common-dir>` for the main
checkout and `<common-dir>/worktrees/<id>` for each linked one. Reading those
files joins the busy set, no fork.

Bisect needs nothing: verified on git 2.55, a bisecting worktree still lists its
branch.

## Visibility

The zero-byte filter stays for what it was written for: a tool prune whose effect
cannot be measured. A ref is different, what goes is known, it just weighs 0 B.

`ACTIONS` gains one flag next to `frees`, `weightless`: `branch-delete` declares
it, and `scan()` keeps items whose action has it even at size 0. The summary row
already prints a count beside the size, so the category reads "60 · 0 B" and the
reclaimable total is unchanged. No ui file changed.

`--yes` takes merged branches. They are `safe: true`, and `safe` already means
"nothing to lose"; a second meaning would need a second flag.

## Out of scope

- **Pushed, not merged.** The remote holds every commit, so deleting the local
  copy loses nothing, but these are open pull requests and work in progress. A
  `safe: false` category could come later; 7 branches did not earn it here.
- **Unmerged without upstream.** The only copy. Never offered.

## The minefield

`src/test/minefield.ts` builds two repos holding every branch a cleaner could be
tempted by, each tagged `keep` or `go` with the reason. It is the contract for
this rule and any later one:

- *the minefield: nothing that must stay is offered, and cleaning everything
  leaves it* runs `collect`, removes every item it offers, and asserts no `keep`
  branch was offered or moved. Green today, must stay green.
- *the minefield: every branch already in main is offered* asserts `collect`
  offers exactly the `go` set. It was `todo` while this was a plan.

| keep | why |
|---|---|
| `main` | the default branch, not checked out |
| `elsewhere` | checked out in the main checkout |
| `unique-local` | no upstream, commits exist nowhere else |
| `unique-pushed` | pushed but not merged |
| `unique-gone` | remote deleted, never merged |
| `tag-twin` | unmerged, a same-named tag sits on main |
| `work-after-squash` | squash-merged, then got more commits |
| `half-picked` | one of two commits was cherry-picked |
| `develop`, `in-develop-only` | merged into another branch, not the default |
| `checked-out` | merged, checked out in a worktree |
| `rebasing` | merged, a rebase of it is in progress |
| `fresh-empty` | created just now on an old tip |
| `no-default/absorbed` | the repo has no default branch to compare with |

| go | why |
|---|---|
| `merged-local` | merged, never pushed |
| `squashed-local` | squash-merged, never pushed |
| `merged-pushed` | merged, remote branch still there |
| `merged-gone` | squash-merged, remote deleted (today's only case) |
| `empty-old` | no commits of its own, created long ago |

Mutation check, done while writing this: dropping the upstream gate alone (rule
1 and 3 without the age and rebase changes) fails the first test with exactly
`rebasing` and `fresh-empty`. Every other `keep` held.

To poke at it by hand:

```bash
npm run build
node dist/test/minefield.js /tmp/field
HOME=/tmp/field node dist/index.js clean --root /tmp/field/minefield --root /tmp/field/no-default
```

The fake `HOME` keeps the real agent state out of the scan and the operations log
inside the field.

## Found while implementing

- **The last branch of every repo was invisible.** `gitAsync` trims its output,
  which strips the empty trailing fields off the last `for-each-ref` line; a last
  branch with no upstream arrived with 2 fields, and `cachedBranchRefs` dropped
  anything but 5. Harmless while no-upstream branches were never candidates. Now it
  accepts 2 to 5, with a regression test that fails without the fix.
- **`+` in a branch name.** Claude Code names a worktree branch after the
  worktree, so `worktree-feat+menu-option-hints` exists on the author's machine.
  `remove()`'s name guard refused it, so that row could only end in `✗`. The name
  goes to git as argv, never through a shell, and the guards that matter (leading
  `-`, `..`, `.lock`, `HEAD`) are separate checks, so `+` is now allowed.
- **No extra fork for the common dir.** `mainRepoOf` stripped `/.git` to get the
  repo, so `<repo>/.git` is the common dir whenever it is a directory; only a
  `.git` file costs a `rev-parse`.

## What changes besides the cleanup

- `CLAUDE.md`, *`branch-gone` needs a deleted upstream*: rewritten around merged
  content as the evidence.
- `README.md`, the never-touched list and the "branch refs stay hidden" sentence.
- `src/test/branches.test.ts`, *the graveyard offers merged branches whose remote
  side is gone*: its `local-only` assertion flips, that branch now goes.
