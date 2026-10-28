import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { CronEngine } from '../src/cron/engine.js';

const tsx = createRequire(import.meta.url).resolve('tsx');

it.each(['EOF', 'SIGINT', 'SIGTERM'] as const)(
  'restores a job in the real CLI, executes while waiting for input, and releases the worker on %s',
  async shutdown => {
    const directory = mkdtempSync(join(tmpdir(), 'harness-cron-cli-'));
    const cronDirectory = join(directory, '.cron');
    const engine = new CronEngine(cronDirectory);
    const prompt = 'scheduled prompt from disk';
    engine.create({ prompt, drauble: true, recurring: false, cron: '* * * * * *' });
    engine.close();
    const mainInputs: string[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const data = JSON.parse(body);
      const memory = String(data.messages[0].content).includes('[memory:');
      if (!memory) mainInputs.push(data.messages.findLast((message: { role: string }) => message.role === 'user').content);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: memory ? '[]' : 'CRON_COMPLETED' }, finish_reason: 'stop' }],
      }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    const child = spawn(process.execPath, [
      '--import', tsx, fileURLToPath(new URL('../src/index.ts', import.meta.url)),
    ], {
      cwd: directory,
      env: { ...process.env, OPENAI_API_KEY: 'local-test', OPENAI_MODEL: 'test',
        OPENAI_API_BASE_URL: `http://127.0.0.1:${address.port}/v1` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = once(child, 'exit');
    try {
      await expect.poll(() => output, { timeout: 8000 }).toContain('CRON_COMPLETED');
      expect(mainInputs).toEqual([prompt]);
      if (shutdown === 'EOF') child.stdin.end();
      else child.kill(shutdown);
      const [code] = await exited;
      expect(code, output).toBe(0);
      expect(readdirSync(cronDirectory)).not.toContain('.lock');
      expect(JSON.parse(readFileSync(join(cronDirectory, 'jobs.json'), 'utf8')).jobs).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000,
);
