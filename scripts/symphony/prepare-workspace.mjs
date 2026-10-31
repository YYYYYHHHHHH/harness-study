import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitScope } from './app-server.mjs';

export function syncBase(workspace, workspaceRoot) {
  const { cwd, git: gitDir } = gitScope(workspace, workspaceRoot);
  const git = (...args) => {
    const result = spawnSync('git', args, {
      cwd, encoding: 'utf8', timeout: 45_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (result.error || result.status !== 0) {
      throw new Error(`git ${args[0]} failed: ${result.error?.message || result.stderr.trim()}`);
    }
    return result.stdout.trim();
  };
  const branch = git('symbolic-ref', '--short', 'HEAD');
  const expected = `codex/symphony-${path.basename(cwd).toLowerCase()}`;
  if (branch !== expected) throw new Error(`Expected issue branch ${expected}, found ${branch}`);
  const defaultBranch = git('ls-remote', '--symref', 'origin', 'HEAD')
    .match(/^ref: refs\/heads\/(.+)\tHEAD$/m)?.[1];
  if (!defaultBranch) throw new Error('Cannot resolve origin default branch');
  git('check-ref-format', `refs/heads/${defaultBranch}`);
  const base = `refs/remotes/origin/${defaultBranch}`;
  git('fetch', '--no-tags', 'origin', `refs/heads/${defaultBranch}:${base}`);
  const headBefore = git('rev-parse', 'HEAD');
  const baseSha = git('rev-parse', base);
  const [ahead, behind] = git('rev-list', '--left-right', '--count', `HEAD...${base}`).split(/\s+/).map(Number);
  const dirty = Boolean(git('status', '--porcelain', '--untracked-files=all'));
  const operation = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']
    .find(name => existsSync(path.join(gitDir, name)));
  let status;
  if (operation) status = 'preserved-operation';
  else if (behind === 0) status = 'up-to-date';
  else if (dirty) status = 'preserved-dirty';
  else if (ahead > 0) status = 'preserved-diverged';
  else {
    git('merge', '--ff-only', '--no-edit', base);
    status = 'fast-forwarded';
  }
  const result = { status, branch, defaultBranch, baseSha, headBefore,
    headAfter: git('rev-parse', 'HEAD'), ahead, behind, dirty, operation: operation ?? null };
  mkdirSync(path.join(cwd, '.symphony'), { recursive: true });
  writeFileSync(path.join(cwd, '.symphony/base-sync.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function prepare() {
  const result = syncBase(process.cwd(), process.env.SYMPHONY_WORKSPACE_ROOT);
  console.log(`Symphony base sync: ${result.status}; ${result.headBefore} -> ${result.headAfter}`);
  // Let the agent inspect and report a dependency blocker without destroying work.
  if (result.status.startsWith('preserved-')) return;
  const stamp = '.symphony/dependencies.sha256';
  const digest = createHash('sha256').update(process.versions.node)
    .update(readFileSync('package.json')).update(readFileSync('package-lock.json')).digest('hex');
  if (!existsSync('node_modules') || !existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== digest) {
    const install = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { stdio: 'inherit', timeout: 120_000 });
    if (install.error || install.status !== 0) throw new Error('npm ci failed; dependency stamp was not updated');
    writeFileSync(stamp, `${digest}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { prepare(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
