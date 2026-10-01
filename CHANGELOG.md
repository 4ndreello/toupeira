# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.0] - 2026-10-01

### Changed

- Local branches are offered once their content is in the default branch,
  whether pushed, deleted on the remote or never pushed. The category is now
  `branch-merged`, and it shows in the scan and picker at 0 B instead of being
  hidden with the unmeasurable prunes.
- A branch's age is when its ref last moved, so a branch made a moment ago from
  an old tip is no longer old.

### Fixed

- A branch being rebased in a worktree is treated as checked out.
- The last branch of a repo is no longer dropped from the listing when it has no
  upstream.
- Branch names containing `+` can be deleted.

[Unreleased]: https://github.com/4ndreello/toupeira/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/4ndreello/toupeira/releases/tag/v0.8.0
