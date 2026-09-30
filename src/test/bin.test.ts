import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { human } from '../index.js'

test('the CLI runs when invoked through a symlink, the way npm installs its bin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toupeira-bin-'))
  try {
    const link = join(dir, 'toupeira')
    symlinkSync(new URL('../index.js', import.meta.url).pathname, link)
    const out = execFileSync(process.execPath, [link, '--help'], { encoding: 'utf8' })
    assert.match(out, /clean up what coding agents leave behind/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('clean prints and logs each completed removal, then reports freed bytes', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-bin-home-'))
  try {
    const project = join(home, '.claude/projects/-tmp-toupeira-missing')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'session.jsonl'), '{"cwd":"/tmp/toupeira-bin-missing"}\n')
    const state = join(home, '.state')
    const bin = new URL('../index.js', import.meta.url).pathname
    const output = execFileSync(process.execPath, [bin, 'clean', '--yes'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, XDG_STATE_HOME: state },
    })
    const operationLog = readFileSync(join(state, 'toupeira/operations.log'), 'utf8')
    const operation = operationLog.match(/^\S+ removed session-orphan (.+) (\d+)$/m)
    assert.ok(operation, `the successful action logs the category, target and size: ${operationLog}\n${output}`)
    const name = operation[1]!
    const displayName = '~/.claude/projects/-tmp-toupeira-missing'
    assert.equal(name, project)
    const size = Number(operation[2])

    assert.equal(existsSync(project), false)
    assert.ok(output.includes(`  \x1b[32m✓\x1b[0m ${displayName}`))
    assert.ok(output.includes(`freed ${human(size)}. log at ~/.state/toupeira/operations.log`))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('clean prints a failed removal and leaves its bytes out of the freed total', () => {
  const home = mkdtempSync(join(tmpdir(), 'toupeira-bin-home-'))
  try {
    const repo = join(home, 'repo')
    const worktree = join(home, 'worktree')
    const dirtyFile = join(worktree, 'toupeira-dirty')
    mkdirSync(repo, { recursive: true })
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    }
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    writeFileSync(join(repo, 'base'), 'base\n')
    git('add', 'base')
    git('commit', '-qm', 'init')
    git('branch', 'done')
    git('worktree', 'add', worktree, 'done')

    const realDu = process.env.PATH?.split(delimiter).map((dir) => join(dir, 'du')).find(existsSync)
    assert.ok(realDu, 'du is available to the test process')
    const hooks = join(home, 'hooks')
    mkdirSync(hooks)
    const duShim = join(hooks, 'du')
    writeFileSync(duShim, [
      '#!/usr/bin/env node',
      "const { spawnSync } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `if (process.argv.includes(${JSON.stringify(worktree)})) writeFileSync(${JSON.stringify(dirtyFile)}, 'dirty');`,
      `const result = spawnSync(${JSON.stringify(realDu)}, process.argv.slice(2), { stdio: 'inherit' });`,
      'if (result.error) throw result.error;',
      'process.exitCode = result.status ?? 1;',
    ].join('\n'))
    chmodSync(duShim, 0o755)

    const state = join(home, '.state')
    const bin = new URL('../index.js', import.meta.url).pathname
    const output = execFileSync(process.execPath, [bin, 'clean', '--yes', '--root', repo], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PATH: `${hooks}${delimiter}${process.env.PATH}`, XDG_STATE_HOME: state },
    })
    const operationLog = readFileSync(join(state, 'toupeira/operations.log'), 'utf8')

    assert.equal(existsSync(worktree), true, 'git refused to remove the worktree after it became dirty')
    assert.equal(existsSync(dirtyFile), true)
    assert.ok(output.includes('  \x1b[31m✗\x1b[0m ~/worktree - the removal reported a failure'))
    assert.ok(operationLog.includes(` failed worktree-merged ${worktree} the removal reported a failure\n`))
    assert.ok(output.includes('freed 0 B. log at ~/.state/toupeira/operations.log'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
