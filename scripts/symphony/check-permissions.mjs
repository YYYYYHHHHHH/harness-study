import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { codexModelArgs, gitScope, withGitPermission } from './app-server.mjs';

test('Symphony pins its model independently and supports an explicit project override', () => {
  assert.deepEqual(codexModelArgs({}), ['--config', 'model="gpt-6-astra"']);
  assert.deepEqual(codexModelArgs({ SYMPHONY_CODEX_MODEL: 'custom-model' }), ['--config', 'model="custom-model"']);
});

test('permission is limited to this clone and preserves the turn policy and tool messages', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'symphony-permissions-'));
  try {
    const workspace = path.join(root, 'ILU-6');
    mkdirSync(path.join(workspace, '.git'), { recursive: true });
    const scope = gitScope(workspace, root);
    const message = { id: 3, method: 'turn/start', params: {
      cwd: workspace, threadId: 'thread', input: [{ type: 'text', text: '你好' }],
      approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite', networkAccess: true },
    } };
    const result = withGitPermission(message, scope);
    assert.deepEqual(result.params.sandboxPolicy, {
      type: 'workspaceWrite', networkAccess: true, writableRoots: [scope.git],
    });
    assert.equal(result.params.approvalPolicy, 'never');
    assert.equal(result.params.input, message.params.input);
    assert.equal(message.params.sandboxPolicy.writableRoots, undefined);
    assert.deepEqual(withGitPermission(result, scope), result);
    const reply = { id: 7, result: { content: [{ type: 'text', text: 'tool result' }] } };
    assert.equal(withGitPermission(reply, scope), reply);
    assert.throws(() => withGitPermission({ ...message, params: { ...message.params, cwd: root } }, scope));
    assert.throws(() => withGitPermission({ ...message, params: { ...message.params, sandboxPolicy: { type: 'dangerFullAccess' } } }, scope));
    assert.throws(() => gitScope(root, root));
    assert.throws(() => gitScope(workspace, undefined));
    rmSync(path.join(workspace, '.git'), { recursive: true });
    symlinkSync(root, path.join(workspace, '.git'));
    assert.throws(() => gitScope(workspace, root));
    rmSync(path.join(workspace, '.git'));
    writeFileSync(path.join(workspace, '.git'), `gitdir: ${root}\n`);
    assert.throws(() => gitScope(workspace, root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real Codex sandbox allows Git writes while keeping sibling and config paths protected', {
  skip: process.env.SYMPHONY_SANDBOX_SMOKE !== '1',
  timeout: 30_000,
}, async () => {
  // Do not place this check in /tmp: workspace-write intentionally permits temp files.
  mkdirSync('.symphony', { recursive: true });
  const root = mkdtempSync(path.resolve('.symphony/permission-check-'));
  const workspace = path.join(root, 'ILU-TEST');
  mkdirSync(workspace);
  mkdirSync(path.join(workspace, '.git'));
  mkdirSync(path.join(workspace, '.codex'));
  const scope = gitScope(workspace, root);
  const policy = withGitPermission({ method: 'turn/start', params: {
    cwd: workspace, sandboxPolicy: { type: 'workspaceWrite', networkAccess: true },
  } }, scope).params.sandboxPolicy;
  const codex = process.env.SYMPHONY_CODEX_BIN || spawnSync('which', ['codex'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(codex, 'Codex must be installed for the smoke test');
  const child = spawn(process.execPath, [path.resolve('scripts/symphony/app-server.mjs')], {
    cwd: workspace,
    env: { ...process.env, SYMPHONY_CODEX_BIN: codex, SYMPHONY_WORKSPACE_ROOT: root },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let next = 0;
  lines.on('line', line => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10_000);
    pending.set(id, message => {
      clearTimeout(timer);
      pending.delete(id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    await rpc('initialize', { clientInfo: { name: 'symphony_permissions_check', version: '1.0' }, capabilities: {} });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const script = `const fs=require('node:fs');
      fs.writeFileSync('.git/permission-probe','ok'); fs.unlinkSync('.git/permission-probe');
      for(const p of ${JSON.stringify([path.join(root, 'outside-probe'), path.join(workspace, '.codex/protected-probe')])}) {
        let denied=false;
        try { fs.writeFileSync(p,'unexpected'); }
        catch(e) { if(['EPERM','EACCES'].includes(e.code)) denied=true; else throw e; }
        if(!denied) throw new Error('Unexpected write access: '+p);
      }`;
    const result = await rpc('command/exec', {
      command: [process.execPath, '-e', script], cwd: workspace, sandboxPolicy: policy,
    });
    assert.equal(result.exitCode, 0, result.stderr);
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    await exited;
    lines.close();
    rmSync(root, { recursive: true, force: true });
  }
});
