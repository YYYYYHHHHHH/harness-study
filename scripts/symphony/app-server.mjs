import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

// Project-scoped model selection: do not inherit an incompatible desktop default.
export function codexModelArgs(env = process.env) {
  return ['--config', `model=${JSON.stringify(env.SYMPHONY_CODEX_MODEL || 'gpt-6-astra')}`];
}

// Symphony 0.0.3 sends a static turn policy, overriding CLI writable roots.
// Bind the extra Git permission to this worker's clone at both layers.
export function gitScope(workspace, workspaceRoot) {
  if (!workspaceRoot) throw new Error('SYMPHONY_WORKSPACE_ROOT is required');
  const cwd = realpathSync(workspace);
  const root = realpathSync(workspaceRoot);
  if (path.dirname(cwd) !== root) throw new Error('Worker must be a direct child of the Symphony workspace root');
  const git = path.join(cwd, '.git');
  if (!lstatSync(git).isDirectory() || realpathSync(git) !== git) {
    throw new Error('Worker requires its own .git directory, not a pointer or symlink');
  }
  return { cwd, git };
}

export function withGitPermission(message, scope) {
  if (message.method !== 'turn/start') return message;
  const params = message.params;
  if (!params?.cwd || realpathSync(params.cwd) !== scope.cwd) {
    throw new Error('Turn cwd differs from the worker clone');
  }
  if (params.sandboxPolicy?.type !== 'workspaceWrite') {
    throw new Error('Symphony must retain the workspaceWrite sandbox');
  }
  return { ...message, params: { ...params, sandboxPolicy: {
    ...params.sandboxPolicy,
    writableRoots: [...new Set([...(params.sandboxPolicy.writableRoots ?? []), scope.git])],
  } } };
}

async function main() {
  const scope = gitScope(process.cwd(), process.env.SYMPHONY_WORKSPACE_ROOT);
  const child = spawn(process.env.SYMPHONY_CODEX_BIN, [
    ...codexModelArgs(),
    '--config', 'shell_environment_policy.inherit=all',
    '--config', `sandbox_workspace_write.writable_roots=${JSON.stringify([scope.git])}`,
    'app-server',
  ], { cwd: scope.cwd, stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdout.pipe(process.stdout);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const fail = error => {
    console.error(`Symphony App Server: ${error.message}`);
    process.exitCode = 1;
    input.close();
    process.stdin.destroy();
    child.kill('SIGTERM');
  };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('exit', (code, signal) => {
    input.close();
    process.stdin.destroy();
    process.exitCode = process.exitCode || code || (signal ? 1 : 0);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      const message = withGitPermission(JSON.parse(line), scope);
      if (!child.stdin.write(`${JSON.stringify(message)}\n`)) await once(child.stdin, 'drain');
    }
    child.stdin.end();
  } catch (error) {
    fail(error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
