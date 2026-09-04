# Security Policy

## Reporting a vulnerability

Report privately through GitHub Security Advisories: the **Security** tab of
this repository, then **Report a vulnerability**. Do not open a public issue
for a security problem.

You can expect an initial reply within a few days. This is a small project
maintained in spare time, so follow-ups may take longer.

## What is in scope

This tool deletes things: worktrees, branches, session logs, caches. Problems
worth reporting include:

- a path guard bypass, where `remove()` deletes outside the intended target
- a file-list action accepting entries outside `action.root` or with an
  unexpected extension
- a `tree: false` category removing a directory it should only read, or a
  `transcript-old` entry removing anything that is not a `.jsonl` idle file
- an item offered for removal that should have been kept: dirty worktree, bare
  worktree, unpushed commits, branch with no upstream, main checkout

## What is out of scope

- Vulnerabilities in `git`, `du` or `docker` themselves, report those upstream.
  Resolving them through `PATH` here is deliberate.
- The scanner reading where agents recorded their working directories. That is
  the design: it never crawls the disk and there is no config file.
- Removals are logged to `~/.local/state/toupeira/operations.log`
  (`XDG_STATE_HOME` honored). The log holds paths and sizes, nothing else.
  There is no server and no telemetry.
