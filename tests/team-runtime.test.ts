import type OpenAI from 'openai';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/agent.js', () => ({ runAgent: vi.fn() }));
import { runAgent, type AgentResult } from '../src/agent.js';
import { TeamRuntime } from '../src/agent-team/runtime.js';
import { MessageBus } from '../src/agent-team/message-bus.js';
import { InboxError } from '../src/agent-team/inbox.js';
import { encodeInboxMessage, inboxPath, teamMessageToUserEvent, type TeamMessage } from '../src/agent-team/protocol.js';
import { tools } from '../src/tools/index.js';
import { toolHandlers } from '../src/tools/handlers.js';
import { dispatchTool, type ToolContext } from '../src/tools/dispatch.js';

const done: AgentResult = { finished: true, finalContent: 'done', rounds: 1 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let workspace: string;
let bus: MessageBus;
let runtime: TeamRuntime;
let context: ToolContext;
const runner = vi.mocked(runAgent);
const specs = { teammates: [{ name: 'writer', prompt: 'write' }, { name: 'tester', prompt: 'test' }] };
const dispatch = (name: string, args: unknown, ctx = context) => dispatchTool(name, JSON.stringify(args), ctx);

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  runner.mockReset().mockResolvedValue(done);
  workspace = await fs.mkdtemp(join(tmpdir(), 'team-runtime-'));
  bus = await MessageBus.open(workspace);
  context = { client: {} as OpenAI, model: 'test', skills: new Map(), tools, runId: 'test', logPrefix: '' };
  runtime = await TeamRuntime.create({ ...context, workspace, bus, runAgent });
  context.team = runtime.clientFor('main');
});
afterEach(async () => {
  await runtime.stop();
  vi.restoreAllMocks();
  await fs.rm(workspace, { recursive: true, force: true });
});

it('registers the whole batch before concurrent execution and returns while both models remain pending', async () => {
  const finish = deferred<AgentResult>();
  const sent: Promise<unknown>[] = [];
  runner.mockImplementation(options => {
    const sender = options.input === 'write' ? 'writer' : 'tester';
    const target = sender === 'writer' ? 'tester' : 'writer';
    sent.push(options.team!.sendMessage({ sender, target, content: 'hello' }));
    return finish.promise;
  });
  try {
    const result = JSON.parse(await dispatch('spawn_teammates', specs));
    expect(result.teammates.map((s: { state: string }) => s.state)).toEqual(['running', 'running']);
    expect(runner).toHaveBeenCalledTimes(2);
    await Promise.all(sent);
    expect(JSON.parse(await fs.readFile(inboxPath(workspace, 'writer'), 'utf8')).sender).toBe('tester');
    expect(JSON.parse(await fs.readFile(inboxPath(workspace, 'tester'), 'utf8')).sender).toBe('writer');
  } finally { finish.resolve(done); }
});

it('keeps isolated histories, IDs, gates and background maps across later message turns', async () => {
  const finish = deferred<AgentResult>();
  const started = deferred<void>();
  runner.mockImplementation(async options => {
    options.messages!.push({ role: 'user', content: options.input });
    if (options.input === 'write') { started.resolve(); return finish.promise; }
    return done;
  });
  await runtime.spawnTeammates(specs);
  await started.promise;
  const first = runner.mock.calls[0][0];
  const other = runner.mock.calls[1][0];
  expect(first.messages).not.toBe(other.messages);
  expect(first.bg_task_map).not.toBe(other.bg_task_map);
  expect(first.agentId).not.toBe(other.agentId);
  for (const options of [first, other]) {
    expect(options).toMatchObject({ client: context.client, model: context.model, memory: false, role: 'teammate' });
    expect(options.skills).toBe(context.skills);
    expect(options.cron).toBeUndefined();
    expect(options.logPrefix).toMatch(/\[teammate:(writer|tester)\]/);
    expect(options.tools.map(t => t.schema.function.name)).toEqual([
      'bash', 'read_file', 'write_file', 'edit_file', 'glob', 'todo_write', 'load_skill', 'send_message',
    ]);
  }
  const message: TeamMessage = { sender: 'tester', target: 'writer', content: 'follow up', id: 'id', created_at: new Date().toISOString() };
  const event = teamMessageToUserEvent(message).content as string;
  const next = runtime.runTurn('writer', event);
  await Promise.resolve();
  expect(runner).toHaveBeenCalledTimes(2); // queued behind writer, while tester already ran
  finish.resolve(done);
  await next;
  const later = runner.mock.calls[2][0];
  expect(later.messages).toBe(first.messages);
  expect(later.bg_task_map).toBe(first.bg_task_map);
  expect(later.agentId).toBe(first.agentId);
  expect(later.messages).toEqual([{ role: 'user', content: 'write' }, { role: 'user', content: event }]);
  expect(other.messages).toEqual([{ role: 'user', content: 'test' }]);
});

it.each([
  { teammates: [] },
  { teammates: [{ name: 'writer', prompt: 'ok' }, { name: 'writer', prompt: 'duplicate' }] },
  { teammates: [{ name: 'writer', prompt: 'ok' }, { name: 'bad/name', prompt: 'bad' }] },
  { teammates: [{ name: 'writer', prompt: 'ok' }, { name: 'tester', prompt: ' ' }] },
  { teammates: [{ name: 'main', prompt: 'reserved' }] },
])('rejects an invalid batch without any registration or execution: %j', async args => {
  const register = vi.spyOn(bus, 'register');
  await expect(dispatch('spawn_teammates', args)).rejects.toThrow();
  expect(register).not.toHaveBeenCalled();
  expect(runner).not.toHaveBeenCalled();
  expect(runtime.status()).toEqual([]);
});

it('rechecks names under the registry lock and rejects the entire competing batch', async () => {
  const results = await Promise.allSettled([runtime.spawnTeammates(specs), runtime.spawnTeammates({ teammates: [
    { name: 'extra', prompt: 'ok' }, ...specs.teammates,
  ] })]);
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
  expect(runtime.status().map(s => s.name)).toEqual(['writer', 'tester']);
  await expect(fs.stat(inboxPath(workspace, 'extra'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('snapshots caller arguments before waiting for the registry lock', async () => {
  const args = structuredClone(specs);
  const spawned = runtime.spawnTeammates(args);
  args.teammates[0].name = 'changed';
  args.teammates[0].prompt = 'changed';
  await spawned;
  expect(runtime.status()[0].name).toBe('writer');
  expect(runner.mock.calls[0][0].input).toBe('write');
});

it('rolls back only this batch’s empty registrations and preserves a preexisting nonempty inbox', async () => {
  await runtime.spawnTeammates({ teammates: [{ name: 'existing', prompt: 'old' }] });
  const legacy: TeamMessage = { id: 'old', sender: 'main', target: 'tester', content: 'preserve', created_at: new Date().toISOString() };
  await fs.writeFile(inboxPath(workspace, 'tester'), encodeInboxMessage(legacy));
  const result = await runtime.spawnTeammates(specs);
  expect(result.teammates.every(s => s.state === 'stopped' && s.error?.phase === 'startup')).toBe(true);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(runtime.status().map(s => s.name)).toEqual(['existing']);
  expect(await fs.readFile(inboxPath(workspace, 'tester'), 'utf8')).toBe(encodeInboxMessage(legacy));
  await expect(bus.append({ sender: 'main', target: 'writer', content: 'no route' })).rejects.toThrow('未知或不接收消息的目标');
  await bus.register('writer'); // empty registration was released; its empty file remains reusable
  await expect(runtime.spawnTeammates(specs)).rejects.toThrow('已占用');
});

it('retains stopped ownership if a batch inbox gains messages before rollback', async () => {
  const register = bus.register.bind(bus);
  vi.spyOn(bus, 'register').mockImplementation(async name => {
    if (name === 'tester') {
      await bus.append({ sender: 'main', target: 'writer', content: 'preserve me' });
      throw new Error('initialization failed');
    }
    await register(name);
  });
  const result = await runtime.spawnTeammates(specs);
  expect(result.teammates[0].error?.message).toContain('initialization failed');
  expect(runtime.status()).toMatchObject([{ name: 'writer', state: 'stopped' }]);
  expect((await bus.peek('writer'))?.content).toBe('preserve me');
  expect(runner).not.toHaveBeenCalled();
  expect(() => runtime.runTurn('writer', 'retry')).toThrow();
});

it('reports rollback errors without starting unowned model runs', async () => {
  vi.spyOn(bus, 'register').mockResolvedValueOnce().mockRejectedValueOnce(new Error('init failed'));
  vi.spyOn(bus, 'unregisterEmpty').mockRejectedValue(new Error('cleanup failed'));
  vi.spyOn(bus, 'error').mockReturnValue(new InboxError('STORAGE', 'init failed', workspace));
  const result = await runtime.spawnTeammates(specs);
  expect(result.teammates[0].error).toMatchObject({ phase: 'storage', message: expect.stringContaining('cleanup failed') });
  expect(runtime.status()).toMatchObject([{ name: 'writer', state: 'stopped' }]);
  expect(runner).not.toHaveBeenCalled();
});

it.each(['throw', 'unfinished'])('records %s model failure without retrying and leaves successful peers managed', async kind => {
  const failed = deferred<AgentResult>();
  runner.mockImplementation(options => options.input === 'write' ? failed.promise : Promise.resolve(done));
  await runtime.spawnTeammates(specs);
  if (kind === 'throw') failed.reject(new Error('model failed'));
  else failed.resolve({ ...done, finished: false });
  await vi.waitFor(() => expect(runtime.status()[0]).toMatchObject({ state: 'stopped', error: { phase: 'model' } }));
  expect(runtime.status()[1].state).toBe('idle');
  expect(() => runtime.runTurn('writer', 'retry')).toThrow();
  expect(runner).toHaveBeenCalledTimes(2);
  await expect(context.team!.sendMessage({ sender: 'main', target: 'writer', content: 'no' })).rejects.toThrow();
});

it('waits for active runs on stop, rejects queued turns and closes the bus once', async () => {
  const finish = deferred<AgentResult>();
  runner.mockReturnValue(finish.promise);
  await runtime.spawnTeammates(specs);
  const queued = runtime.runTurn('writer', 'queued');
  const rejected = expect(queued).rejects.toThrow('停止');
  const close = vi.spyOn(bus, 'close');
  const stopping = runtime.stop();
  expect(runtime.stop()).toBe(stopping);
  expect(close).not.toHaveBeenCalled();
  await expect(runtime.spawnTeammates({ teammates: [{ name: 'new', prompt: 'new' }] })).rejects.toThrow('停止');
  finish.resolve(done);
  await stopping;
  await rejected;
  expect(runner).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(1);
  expect(runtime.status().every(s => s.state === 'stopped')).toBe(true);
});

it('stops admission and reports shared storage failures to the lifecycle owner', async () => {
  await runtime.spawnTeammates(specs);
  const error = new InboxError('STORAGE', 'disk failed', workspace);
  vi.spyOn(bus, 'append').mockRejectedValue(error);
  vi.spyOn(bus, 'error').mockReturnValue(error);
  await expect(dispatch('send_message', { sender: 'main', target: 'tester', content: 'hi' })).rejects.toThrow('disk failed');
  expect(runtime.status().every(s => s.error?.phase === 'storage')).toBe(true);
  await expect(runtime.spawnTeammates({ teammates: [{ name: 'new', prompt: 'new' }] })).rejects.toThrow('停止');
});

it('binds sender identity, preserves send_message, and enforces role permissions even with the full tool registry', async () => {
  await runtime.spawnTeammates(specs);
  const teammate = { ...context, role: 'teammate' as const, team: runtime.clientFor('writer') };
  const delivered = JSON.parse(await dispatch('send_message', { sender: 'writer', target: 'main', content: 'hello' }, teammate));
  expect(delivered).toMatchObject({ sender: 'writer', target: 'main', content: 'hello', id: expect.any(String) });
  await expect(dispatch('send_message', { sender: 'main', target: 'tester', content: 'forged' }, teammate)).rejects.toThrow('身份');
  await expect(dispatch('send_message', { sender: 'writer', target: 'tester', content: 'hello', extra: true }, teammate)).rejects.toThrow('未知字段');
  await expect(teammate.team.spawnTeammates(specs)).rejects.toThrow('只有 main');
  for (const name of ['create_tasks', 'clamic_task', 'get_tasks_detail', 'complate_tasks',
    'create_cron_job', 'cancel_cron_job', 'list_cron_job', 'spawn_subagent', 'spawn_teammates']) {
    await expect(dispatchTool(name, 'not JSON', teammate)).rejects.toThrow('未启用工具');
  }
  await expect(toolHandlers.spawn_teammates(specs, teammate)).rejects.toThrow('只有 main');
  for (const name of ['spawn_teammates', 'send_message']) {
    await expect(dispatch(name, {}, { ...context, team: undefined })).rejects.toThrow('运行时未启用');
    await expect(dispatch(name, {}, { ...context, role: 'subagent' })).rejects.toThrow('未启用工具');
  }
});

it('does not launch a batch if stop races with inbox initialization', async () => {
  const registering = deferred<void>();
  const release = deferred<void>();
  const register = bus.register.bind(bus);
  vi.spyOn(bus, 'register').mockImplementation(async name => {
    await register(name);
    if (name === 'writer') { registering.resolve(); await release.promise; }
  });
  const spawning = runtime.spawnTeammates(specs);
  await registering.promise;
  const stopped = runtime.stop();
  release.resolve();
  const result = await spawning;
  await stopped;
  expect(result.teammates.every(s => s.state === 'stopped')).toBe(true);
  expect(runtime.status()).toEqual([]);
  expect(runner).not.toHaveBeenCalled();
});

it('opens and releases its own bus, including failed main registration', async () => {
  await runtime.stop();
  runtime = await TeamRuntime.create({ ...context, workspace, runAgent });
  await runtime.stop();
  const legacy: TeamMessage = { id: 'old', sender: 'main', target: 'main', content: 'preserve', created_at: new Date().toISOString() };
  await fs.writeFile(inboxPath(workspace, 'main'), encodeInboxMessage(legacy));
  await expect(TeamRuntime.create({ ...context, workspace, runAgent })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  const reopened = await MessageBus.open(workspace);
  await reopened.close();
  expect(await fs.readFile(inboxPath(workspace, 'main'), 'utf8')).toBe(encodeInboxMessage(legacy));
});

it('automatically drains durable messages after initial and direct turns with the same session', async () => {
  const finish = deferred<AgentResult>();
  runner.mockReturnValueOnce(finish.promise);
  await runtime.spawnTeammates({ teammates: [specs.teammates[0]] });
  const message = await context.team!.sendMessage({ sender: 'main', target: 'writer', content: 'follow up' });
  finish.resolve(done);
  await vi.waitFor(() => expect(runtime.status()[0].state).toBe('idle'));
  expect(runner.mock.calls[1][0].input).toBe(teamMessageToUserEvent(message).content);
  expect(runner.mock.calls[1][0].messages).toBe(runner.mock.calls[0][0].messages);
  expect(await fs.readFile(inboxPath(workspace, 'writer'), 'utf8')).toBe('');
  const next = await context.team!.sendMessage({ sender: 'main', target: 'writer', content: 'after direct' });
  await runtime.runTurn('writer', 'direct');
  expect(runner.mock.calls.slice(2).map(([options]) => options.input)).toEqual(['direct', teamMessageToUserEvent(next).content]);
  expect(await fs.readFile(inboxPath(workspace, 'writer'), 'utf8')).toBe('');
});

it('preserves a failed inbox head and unread messages on disk while peers continue', async () => {
  const finish = deferred<AgentResult>();
  runner.mockReturnValueOnce(finish.promise);
  await runtime.spawnTeammates(specs);
  const first = await context.team!.sendMessage({ sender: 'main', target: 'writer', content: 'bad' });
  await context.team!.sendMessage({ sender: 'main', target: 'writer', content: 'unread' });
  const before = await fs.readFile(inboxPath(workspace, 'writer'), 'utf8');
  runner.mockImplementation(async options => {
    if (options.input === teamMessageToUserEvent(first).content) throw new Error('inbox model failure');
    return done;
  });
  finish.resolve(done);
  await vi.waitFor(() => expect(runtime.status()[0]).toMatchObject({ state: 'stopped', error: { phase: 'model', messageId: first.id } }));
  expect(bus.error('writer')).toMatchObject({ code: 'CONSUMER_FAILED', messageId: first.id });
  expect(await fs.readFile(inboxPath(workspace, 'writer'), 'utf8')).toBe(before);
  await expect(runtime.runTurn('tester', 'still healthy')).resolves.toBe(done);
  expect(runtime.status()[1].state).toBe('idle');
});

it('isolates a corrupt inbox storage failure from healthy teammates', async () => {
  const finish = deferred<AgentResult>();
  runner.mockReturnValueOnce(finish.promise);
  await runtime.spawnTeammates(specs);
  await context.team!.sendMessage({ sender: 'main', target: 'writer', content: 'preserve' });
  await fs.appendFile(inboxPath(workspace, 'writer'), '{');
  const before = await fs.readFile(inboxPath(workspace, 'writer'), 'utf8');
  finish.resolve(done);
  await vi.waitFor(() => expect(runtime.status()[0]).toMatchObject({ state: 'stopped', error: { phase: 'storage' } }));
  expect(await fs.readFile(inboxPath(workspace, 'writer'), 'utf8')).toBe(before);
  const message = await context.team!.sendMessage({ sender: 'main', target: 'tester', content: 'healthy route' });
  await runtime.runTurn('tester', 'still healthy');
  expect(runner.mock.calls.at(-1)![0].input).toBe(teamMessageToUserEvent(message).content);
  expect(await fs.readFile(inboxPath(workspace, 'tester'), 'utf8')).toBe('');
  expect(bus.error('tester')).toBeUndefined();
});


it('stops only the target when durable append fails and records its message id', async () => {
  await runtime.spawnTeammates(specs);
  await vi.waitFor(() => expect(runtime.status().every(s => s.state === 'idle')).toBe(true));
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('target write failed'));
  await expect(context.team!.sendMessage({ sender: 'main', target: 'writer', content: 'failed append' })).rejects.toThrow('target write failed');
  expect(runtime.status()[0]).toMatchObject({ state: 'stopped', error: { phase: 'storage', messageId: expect.any(String) } });
  const message = await context.team!.sendMessage({ sender: 'main', target: 'tester', content: 'healthy' });
  await runtime.runTurn('tester', 'direct');
  expect(runner.mock.calls.at(-1)![0].input).toBe(teamMessageToUserEvent(message).content);
  expect(runtime.status()[1].state).toBe('idle');
});
