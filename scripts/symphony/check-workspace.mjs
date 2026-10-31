import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { syncBase } from './prepare-workspace.mjs';

const project = path.resolve(import.meta.dirname, '../..');
function run(cwd, command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'symphony-base-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const workspaces = path.join(root, 'workspaces');
  const workspace = path.join(workspaces, 'ILU-TEST');
  mkdirSync(workspaces);
  const git = (cwd, ...args) => run(cwd, 'git', args);
  git(root, 'init', '--bare', '--initial-branch=trunk', remote);
  git(root, 'clone', remote, seed);
  git(seed, 'config', 'user.name', 'Test');
  git(seed, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(path.join(seed, '.gitignore'), '.symphony/\nnode_modules/\n');
  writeFileSync(path.join(seed, 'base.txt'), 'baseline\n');
  writeFileSync(path.join(seed, 'package.json'), '{}\n');
  writeFileSync(path.join(seed, 'package-lock.json'), '{}\n');
  git(seed, 'add', '.');
  git(seed, '-c', 'commit.gpgsign=false', 'commit', '-m', 'baseline');
  git(seed, 'push', 'origin', 'trunk');
  git(root, 'clone', remote, workspace);
  git(workspace, 'switch', '-c', 'codex/symphony-ilu-test');
  git(workspace, 'config', 'user.name', 'Test');
  git(workspace, 'config', 'user.email', 'test@example.invalid');
  const advance = () => {
    writeFileSync(path.join(seed, 'dependency.txt'), 'merged dependency\n');
    git(seed, 'add', '.');
    git(seed, '-c', 'commit.gpgsign=false', 'commit', '-m', 'merged predecessor');
    git(seed, 'push', 'origin', 'trunk');
    return git(seed, 'rev-parse', 'HEAD');
  };
  return { root, remote, seed, workspaces, workspace, git, advance };
}

test('clean retries fast-forward to the remote default branch and keep local reports', t => {
  const f = fixture(t);
  mkdirSync(path.join(f.workspace, '.symphony'));
  writeFileSync(path.join(f.workspace, '.symphony/result.md'), 'keep report');
  const target = f.advance();
  const result = syncBase(f.workspace, f.workspaces);
  assert.equal(result.defaultBranch, 'trunk');
  assert.equal(result.status, 'fast-forwarded');
  assert.equal(result.headAfter, target);
  assert.equal(readFileSync(path.join(f.workspace, '.symphony/result.md'), 'utf8'), 'keep report');
  assert.equal(syncBase(f.workspace, f.workspaces).status, 'up-to-date');
});

for (const dirtyFile of ['base.txt', 'dependency.txt']) {
  test(`preserves uncommitted ${dirtyFile}, including untracked collisions`, t => {
    const f = fixture(t);
    f.advance();
    writeFileSync(path.join(f.workspace, dirtyFile), 'unfinished work\n');
    const before = f.git(f.workspace, 'rev-parse', 'HEAD');
    const result = syncBase(f.workspace, f.workspaces);
    assert.equal(result.status, 'preserved-dirty');
    assert.equal(result.headAfter, before);
    assert.equal(readFileSync(path.join(f.workspace, dirtyFile), 'utf8'), 'unfinished work\n');
  });
}

test('preserves diverged task commits, but allows a branch already ahead of the base', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.workspace, 'task.txt'), 'task work\n');
  f.git(f.workspace, 'add', 'task.txt');
  f.git(f.workspace, '-c', 'commit.gpgsign=false', 'commit', '-m', 'task commit');
  assert.equal(syncBase(f.workspace, f.workspaces).status, 'up-to-date');
  f.advance();
  const before = f.git(f.workspace, 'rev-parse', 'HEAD');
  const result = syncBase(f.workspace, f.workspaces);
  assert.equal(result.status, 'preserved-diverged');
  assert.equal(result.headAfter, before);
});

test('rejects the wrong branch and preserves an in-progress Git operation', t => {
  const f = fixture(t);
  f.git(f.workspace, 'switch', 'trunk');
  assert.throws(() => syncBase(f.workspace, f.workspaces), /Expected issue branch/);
  f.git(f.workspace, 'switch', 'codex/symphony-ilu-test');
  writeFileSync(path.join(f.workspace, '.git/CHERRY_PICK_HEAD'), `${f.git(f.workspace, 'rev-parse', 'HEAD')}\n`);
  assert.equal(syncBase(f.workspace, f.workspaces).status, 'preserved-operation');
});

test('bootstrap ignores stale local HEAD and installs dependencies once for the current manifests', t => {
  const f = fixture(t);
  const target = f.advance();
  // Use the stale clone as PROJECT_ROOT, just as the original bug did.
  const scripts = path.join(f.workspace, 'scripts/symphony');
  mkdirSync(scripts, { recursive: true });
  for (const name of ['prepare-workspace.mjs', 'app-server.mjs']) {
    writeFileSync(path.join(scripts, name), readFileSync(path.join(project, 'scripts/symphony', name)));
  }
  const bin = path.join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'bd'), '#!/bin/sh\nmkdir -p "$BEADS_DIR"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nmkdir -p node_modules\necho install >> .symphony/install-count\n', { mode: 0o755 });
  const fresh = path.join(f.workspaces, 'ILU-NEW');
  mkdirSync(fresh);
  const env = { ...process.env, SYMPHONY_PROJECT_ROOT: f.workspace,
    SYMPHONY_WORKSPACE_ROOT: f.workspaces, SYMPHONY_NODE_BIN: bin };
  run(fresh, 'bash', [path.join(project, 'scripts/symphony/bootstrap.sh')], env);
  assert.equal(f.git(fresh, 'rev-parse', 'HEAD'), target);
  assert.equal(f.git(fresh, 'branch', '--show-current'), 'codex/symphony-ilu-new');
  const prepare = () => run(fresh, process.execPath, [path.join(scripts, 'prepare-workspace.mjs')], {
    ...env, PATH: `${bin}:${process.env.PATH}`,
  });
  prepare();
  assert.equal(readFileSync(path.join(fresh, '.symphony/install-count'), 'utf8'), 'install\n');
  writeFileSync(path.join(fresh, 'package-lock.json'), '{"lockfileVersion":3}\n');
  prepare();
  assert.equal(readFileSync(path.join(fresh, '.symphony/install-count'), 'utf8'), 'install\ninstall\n');
});
