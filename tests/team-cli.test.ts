import { createServer, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { CronEngine } from '../src/cron/engine.js';
import { encodeInboxMessage, inboxPath } from '../src/agent-team/protocol.js';

const poll: typeof expect.poll = (callback, options) => expect.poll(callback, { timeout: 8000, ...options });
const tsx = createRequire(import.meta.url).resolve('tsx');
type Message = { role: string; content: string; tool_calls?: { function: { name: string } }[] };
type Request = { messages: Message[]; tools?: { function: { name: string } }[] };
const answer = (response: ServerResponse, content: string) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
};
function tool(response: ServerResponse, name: string, args: unknown) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
    { id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
  ] }, finish_reason: 'tool_calls' }] }));
}
const lastInput = (request: Request) => request.messages.findLast(message => message.role === 'user')!.content;
const identity = (request: Request) => /你是 teammate「([^」]+)」/.exec(request.messages[0].content)?.[1] ?? 'main';

async function launch(handle: (request: Request, response: ServerResponse) => void, scheduled = false) {
  const workspace = mkdtempSync(join(tmpdir(), 'harness-team-cli-'));
  if (scheduled) {
    const engine = new CronEngine(join(workspace, '.cron'));
    engine.create({ prompt: 'scheduled', drauble: true, recurring: false, cron: '* * * * * *' });
    engine.close();
  }
  const requests: Request[] = [];
  const failures: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const data: Request = JSON.parse(body);
      requests.push(data);
      if (data.messages[0].content.includes('[memory:')) answer(response, '[]');
      else handle(data, response);
    } catch (error) { failures.push(error); response.destroy(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const child = spawn(process.execPath, ['--import', tsx, fileURLToPath(new URL('../src/index.ts', import.meta.url))], {
    cwd: workspace,
    env: { ...process.env, OPENAI_API_KEY: 'local-test', OPENAI_MODEL: 'test',
      OPENAI_API_BASE_URL: `http://127.0.0.1:${address.port}/v1` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = once(child, 'exit');
  return { workspace, child, requests, failures, exited, output: () => output,
    async dispose() {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

it('integrates user/cron/inbox history, A -> B -> main delivery, post-loop drain and idle wake in the CLI', async () => {
  let heldMain: ServerResponse | undefined;
  let reportQueued = false;
  let mainActive = 0;
  let maxMainActive = 0;
  let mainReleased = 0;
  let reportStarted = 0;
  let idleReply: ServerResponse | undefined;
  const transcripts = new Map<string, Request[]>();
  const app = await launch((request, response) => {
    const who = identity(request);
    const input = lastInput(request);
    const last = request.messages.at(-1)!;
    const list = transcripts.get(who) ?? [];
    list.push(request);
    transcripts.set(who, list);
    if (who === 'main') {
      maxMainActive = Math.max(maxMainActive, ++mainActive);
      response.on('finish', () => { mainActive--; });
      if (input === 'start' && last.role === 'user') {
        tool(response, 'spawn_teammates', { teammates: [{ name: 'a', prompt: 'relay' }, { name: 'b', prompt: 'wait' }] });
      } else if (input === 'start') heldMain = response;
      else if (input === 'wake' && last.role === 'user') tool(response, 'send_message', { sender: 'main', target: 'b', content: 'later' });
      else {
        if (input.includes('report from b')) reportStarted = Date.now();
        answer(response, `MAIN_DONE:${input}`);
      }
    } else if (who === 'a' && last.role === 'user') {
      tool(response, 'send_message', { sender: 'a', target: 'b', content: 'relay from a' });
    } else if (who === 'b' && input.includes('relay from a') && last.role === 'user') {
      tool(response, 'send_message', { sender: 'b', target: 'main', content: 'report from b' });
    } else if (who === 'b' && input.includes('later') && last.role === 'user') {
      idleReply = response;
    } else {
      if (who === 'b' && input.includes('relay from a')) reportQueued = true;
      answer(response, 'TEAM_DONE');
    }
  }, true);
  try {
    await poll(app.output).toContain('❯');
    app.child.stdin.write('start\n');
    await poll(() => !!heldMain && reportQueued).toBe(true);
    app.child.stdin.write('second\n');
    // Keep main busy across at least one cron tick. Neither cron nor queued user
    // input may issue a concurrent request against its conversation.
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(transcripts.get('main')?.some(r => lastInput(r) === 'second')).toBe(false);
    mainReleased = Date.now();
    answer(heldMain!, 'INITIAL_DONE');
    await poll(() => reportStarted).toBeGreaterThan(0);
    expect(reportStarted - mainReleased).toBeLessThan(1000);
    await poll(app.output, { timeout: 8000 }).toContain('MAIN_DONE:scheduled');
    await poll(app.output).toContain('MAIN_DONE:second');
    app.child.stdin.write('wake\n');
    await poll(() => !!idleReply).toBe(true);
    await poll(app.output).toContain('MAIN_DONE:wake');
    tool(idleReply!, 'send_message', { sender: 'b', target: 'main', content: 'idle report' });
    await poll(() => transcripts.get('main')!.some(r => lastInput(r).includes('idle report'))).toBe(true);
    await poll(() => readFileSync(inboxPath(app.workspace, 'main'), 'utf8')).toBe('');
    expect(maxMainActive).toBe(1);
    const main = transcripts.get('main')!;
    const lastMain = main.at(-1)!;
    const inputs = lastMain.messages.filter(m => m.role === 'user').map(m => m.content);
    expect(inputs).toEqual(expect.arrayContaining(['start', 'second', 'scheduled', 'wake']));
    expect(inputs.some(s => s.includes('report from b'))).toBe(true);
    for (const name of ['a', 'b']) {
      const request = transcripts.get(name)!.at(-1)!;
      expect(request.messages.some(m => m.content === 'start')).toBe(false);
      expect(request.messages[0].content).not.toMatch(/create_tasks|create_cron_job|spawn_subagent/);
      expect(request.tools!.map(t => t.function.name)).not.toContain('create_cron_job');
      expect(request.messages[0].content).toContain('普通最终答复不会自动发送给 main');
    }
    expect(transcripts.get('b')!.at(-1)!.messages.some(m => m.content === 'wait')).toBe(true);
    expect(app.requests.some(r => r.messages[0].content.includes('[memory:extract]'))).toBe(true);
    expect(app.output()).toContain('[main] [hook]');
    expect(app.failures).toEqual([]);
    app.child.stdin.end();
    await poll(() => app.child.exitCode, { timeout: 6000, message: 'CLI must exit: ' + app.output() }).not.toBeNull();
    const [code] = await app.exited;
    expect(code, app.output()).toBe(0);
    expect(readdirSync(join(app.workspace, '.teammates_inbox'))).not.toContain('.lock');
    expect(app.output()).not.toMatch(/UnhandledPromiseRejection|unhandled rejection/i);
  } catch (error) { console.error(app.output()); throw error; } finally { await app.dispose(); }
}, 20000);

it.each(['EOF', 'SIGINT', 'SIGTERM'] as const)('stops active main/team requests on %s, preserves messages and never launches queued loops', async shutdown => {
  const blocked = new Set<string>();
  const app = await launch((request, response) => {
    const who = identity(request);
    const input = lastInput(request);
    if (who === 'main' && input === 'start' && request.messages.at(-1)!.role === 'user') {
      tool(response, 'spawn_teammates', { teammates: [{ name: 'a', prompt: 'hold' }] });
    } else if (who === 'a' || input === 'hold main') blocked.add(who);
    else answer(response, 'READY');
  });
  try {
    await poll(app.output).toContain('❯');
    app.child.stdin.write('start\n');
    await poll(app.output).toContain('READY');
    app.child.stdin.write('hold main\nqueued user\n');
    await poll(() => blocked.size).toBe(2);
    const preserved = encodeInboxMessage({ id: 'pending', sender: 'a', target: 'main', content: 'preserve pending', created_at: new Date().toISOString() });
    appendFileSync(inboxPath(app.workspace, 'main'), preserved);
    const before = app.requests.length;
    if (shutdown === 'EOF') app.child.stdin.end();
    else app.child.kill(shutdown);
    await poll(() => app.child.exitCode, { timeout: 6000, message: 'CLI must exit: ' + app.output() }).not.toBeNull();
    const [code] = await app.exited;
    expect(code, app.output()).toBe(0);
    expect(app.requests).toHaveLength(before);
    expect(readFileSync(inboxPath(app.workspace, 'main'), 'utf8')).toBe(preserved);
    expect(readdirSync(join(app.workspace, '.teammates_inbox'))).not.toContain('.lock');
    expect(readdirSync(join(app.workspace, '.cron'))).not.toContain('.lock');
    expect(app.output()).not.toMatch(/UnhandledPromiseRejection|unhandled rejection/i);
    expect(app.failures).toEqual([]);
  } catch (error) { console.error(app.output()); throw error; } finally { await app.dispose(); }
}, 15000);

it('logs a detached teammate failure by agent and keeps the main CLI usable without unhandled rejections', async () => {
  const app = await launch((request, response) => {
    if (identity(request) === 'a') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [] }));
    } else if (lastInput(request) === 'start' && request.messages.at(-1)!.role === 'user') {
      tool(response, 'spawn_teammates', { teammates: [{ name: 'a', prompt: 'fail independently' }] });
    } else answer(response, 'MAIN_OK');
  });
  try {
    await poll(app.output).toContain('❯');
    app.child.stdin.write('start\n');
    await poll(app.output).toContain('[agent:teammate:a:');
    await poll(app.output).toContain('MAIN_OK');
    app.child.stdin.write('still healthy\n');
    await poll(() => app.requests.some(r => lastInput(r) === 'still healthy')).toBe(true);
    await poll(() => app.output().match(/MAIN_OK/g)?.length).toBe(2);
    app.child.stdin.end();
    await poll(() => app.child.exitCode).toBe(0);
    expect(app.output()).not.toMatch(/UnhandledPromiseRejection|unhandled rejection/i);
    expect(app.failures).toEqual([]);
  } finally { await app.dispose(); }
}, 15000);
