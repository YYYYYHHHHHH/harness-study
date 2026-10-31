import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as ioDelay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Keep the agent loop, dispatcher, runtime, consumer and disk bus real. Only
// model/host side effects are mocked; this suite cannot contact a model API.
vi.mock('js-tiktoken', () => ({
  encodingForModel: () => ({ encode: (text: string) => ({ length: text.length }) }),
  getEncoding: () => ({ encode: (text: string) => ({ length: text.length }) }),
}));
vi.mock('../src/skills/index.js', () => ({ scanSkills: async () => new Map(), buildSkillsPrompt: () => '' }));
vi.mock('../src/permissions/index.js', () => ({ checkPermission: async () => ({ allowed: true }) }));
vi.mock('../src/context-snapshots.js', () => ({ saveContextSnapshot: vi.fn() }));
vi.mock('ora', () => ({ default: () => ({ start() { return this; }, stop() {}, fail() {}, succeed() {}, warn() {} }) }));
import { runAgent, type AgentOptions } from '../src/agent.js';
import { AgentTurns } from '../src/agent-turns.js';
import { MessageBus } from '../src/agent-team/message-bus.js';
import { TeamRuntime } from '../src/agent-team/runtime.js';
import { inboxPath, INBOX_DIRECTORY, type TeamMessage } from '../src/agent-team/protocol.js';
import { tools } from '../src/tools/index.js';

const answer = (content = 'done') => ({ choices: [{ message: { role: 'assistant', content } }] });
const call = (name: string, args: unknown, id = name) => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
});
const calls = (...tool_calls: ReturnType<typeof call>[]) => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls } }],
});
type Request = { messages: ChatCompletionMessageParam[] };
type Response = ReturnType<typeof answer> | ReturnType<typeof calls>;
const inputs = (messages: ChatCompletionMessageParam[]) => messages.filter(m => m.role === 'user').map(m => String(m.content));
const event = (input: string): TeamMessage => JSON.parse(input).message;
const actor = (request: Request) => String(request.messages[0].content).match(/你是 teammate「([^」]+)」/)?.[1] ?? 'main';

// Disk completion is independent of the virtual clock. Wait only for observable
// conditions, without advancing inbox deadlines or relying on fixed sleeps.
async function settled(condition: () => boolean) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (condition()) return;
    await ioDelay(2);
  }
  expect(condition(), 'disk/agent work did not settle').toBe(true);
}
let releases: (() => void)[];
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  releases.push(resolve);
  return { promise, resolve };
}
let workspace: string;
let bus: MessageBus;
let runtime: TeamRuntime;
let mainTurns: AgentTurns;
let history: ChatCompletionMessageParam[];
let runs: AgentOptions[];
let active: Map<string, number>;
let peak: Map<string, number>;
let requests: { name: string; messages: ChatCompletionMessageParam[] }[];
let model: (request: Request) => Promise<Response>;
let main: ReturnType<TeamRuntime['registerMain']>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-10-31T00:00:00.000Z'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  releases = []; runs = []; requests = []; history = []; active = new Map(); peak = new Map();
  model = async () => answer();
  workspace = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'agent-team-workflow-'));
  bus = await MessageBus.open(workspace);
  const client = { chat: { completions: { create: async (request: Request) => {
    requests.push({ name: actor(request), messages: structuredClone(request.messages) });
    return model(request);
  } } } } as unknown as OpenAI;
  const execute = async (options: AgentOptions) => {
    const id = options.agentId!;
    active.set(id, (active.get(id) ?? 0) + 1);
    peak.set(id, Math.max(peak.get(id) ?? 0, active.get(id)!));
    runs.push(options);
    try { return await runAgent(options); }
    finally { active.set(id, active.get(id)! - 1); }
  };
  runtime = await TeamRuntime.create({ workspace, bus, client, model: 'mock', tools, skills: new Map(), runAgent: execute });
  mainTurns = new AgentTurns();
  main = runtime.registerMain({ agentId: 'main:test', turns: mainTurns, execute: input => execute({
    client, model: 'mock', tools, skills: new Map(), input, systemPrompt: 'trusted main',
    messages: history, agentId: 'main:test', role: 'main', memory: false, team: runtime.clientFor('main'),
  }) });
});
afterEach(async () => {
  // A failed assertion must still release controlled model/I/O barriers.
  for (const release of releases) release();
  try {
    await runtime?.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect([...active.values()].every(count => count === 0)).toBe(true);
    expect([...peak.values()].every(count => count === 1), 'same agent reentered').toBe(true);
    const count = runs.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toHaveLength(count);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
const disk = (name: string) => fs.readFile(inboxPath(workspace, name), 'utf8');
const idle = (...names: string[]) => settled(() => names.every(name => runtime.status().find(s => s.name === name)?.state === 'idle'));
const mainIdle = () => settled(() => !mainTurns.busy);

it('runs a complete parallel team workflow, drains once in FIFO order and retains every session', async () => {
  const aStarted = latch(); const bStarted = latch();
  const releaseA = latch(); const releaseB = latch();
  const acknowledge = vi.spyOn(bus, 'acknowledge');
  model = async request => {
    const name = actor(request);
    const last = request.messages.at(-1)!;
    if (last.role === 'tool') return answer(`${name} completed`);
    const input = inputs(request.messages).at(-1)!;
    if (name === 'main' && input === 'build team') return calls(call('spawn_teammates', {
      teammates: [{ name: 'a', prompt: 'initial a' }, { name: 'b', prompt: 'initial b' }],
    }));
    if (name === 'a' && input === 'initial a') {
      aStarted.resolve(); await releaseA.promise;
      return calls(...['first', 'second'].map((content, i) => call('send_message', { sender: 'a', target: 'b', content }, `send-${i}`)));
    }
    if (name === 'b' && input === 'initial b') { bStarted.resolve(); await releaseB.promise; }
    if (name === 'b' && input.startsWith('{')) {
      expect(vi.getTimerCount()).toBe(2); // only idle main and a; b has no inbox timer
      return calls(call('send_message', { sender: 'b', target: 'main', content: `reply:${event(input).content}` }));
    }
    return answer(`${name}:${input}`);
  };
  const initial = main.run('build team');
  await Promise.all([aStarted.promise, bStarted.promise]);
  // Both prompts reached the model before either was allowed to complete.
  expect(runtime.status().map(s => s.state)).toEqual(['running', 'running']);
  await initial;
  expect(vi.getTimerCount()).toBe(1);
  releaseA.resolve();
  await idle('a');
  const queued = (await disk('b')).trim().split('\n').map(line => JSON.parse(line) as TeamMessage);
  expect(queued.map(m => m.content)).toEqual(['first', 'second']);
  expect(runs.filter(r => r.input.startsWith('{'))).toEqual([]);
  expect(vi.getTimerCount()).toBe(2);
  releaseB.resolve();
  await idle('b');
  expect(await disk('b')).toBe('');
  const replies = (await disk('main')).trim().split('\n').map(line => JSON.parse(line) as TeamMessage);
  expect(replies.map(m => m.content)).toEqual(['reply:first', 'reply:second']);
  expect(vi.getTimerCount()).toBe(3);
  await vi.advanceTimersByTimeAsync(999);
  expect(inputs(history)).toEqual(['build team']);
  await vi.advanceTimersByTimeAsync(1);
  await mainIdle(); await idle('a', 'b');
  expect(inputs(history).slice(1).map(input => event(input).id)).toEqual(replies.map(m => m.id));
  expect(acknowledge.mock.calls).toEqual([...queued.map(m => ['b', m.id]), ...replies.map(m => ['main', m.id])]);
  expect(new Set(runs.filter(r => r.input.startsWith('{')).map(r => event(r.input).id)).size).toBe(4);
  await main.run('continue main');
  await runtime.runTurn('b', 'continue b');
  const bRequests = requests.filter(r => r.name === 'b');
  expect(inputs(bRequests.at(-1)!.messages)).toEqual(['initial b', ...queued.map(message => JSON.stringify({ type: 'team_message', message })), 'continue b']);
  expect(bRequests.at(-1)!.messages.filter(m => m.role === 'assistant').length).toBeGreaterThan(2);
  expect(inputs(history)).toHaveLength(4);
  const bRuns = runs.filter(r => r.logPrefix === '[teammate:b]');
  expect(new Set(bRuns.map(r => r.messages)).size).toBe(1);
  expect(new Set(bRuns.map(r => r.agentId)).size).toBe(1);
  expect(new Set(bRuns.map(r => r.bg_task_map)).size).toBe(1);
  for (const name of ['main', 'a', 'b']) expect(await disk(name)).toBe('');
  await runtime.stop();
  expect((await fs.readdir(join(workspace, INBOX_DIRECTORY))).sort()).toEqual(['a.jsonl', 'b.jsonl', 'main.jsonl']);
});

it.each(['tick-first', 'completion-first'])('preserves concurrent deliveries when completion collides with a stale tick: %s', async order => {
  const entered = latch(); const finish = latch();
  model = async request => {
    expect(vi.getTimerCount()).toBe(0);
    if (inputs(request.messages).at(-1) === 'initial') { entered.resolve(); await finish.promise; }
    return answer();
  };
  main.start();
  const running = main.run('initial');
  await entered.promise;
  const deliveries = await Promise.all(Array.from({ length: 6 }, (_, i) => runtime.clientFor('main').sendMessage({
    sender: 'main', target: 'main', content: `message-${i}`,
  })));
  if (order === 'tick-first') main.tick();
  finish.resolve();
  await running;
  if (order === 'completion-first') {
    // The old loop has actually released its gate and restored the idle timer.
    main.tick();
    await mainIdle();
  }
  expect(runs.slice(1).map(r => event(r.input).id)).toEqual(deliveries.map(m => m.id));
  expect(await disk('main')).toBe('');
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1000);
  await mainIdle();
  expect(runs).toHaveLength(7);
});

it('finds a durable delivery in the empty-read/idle window on the next 1-second poll', async () => {
  const emptyRead = latch(); const releaseRead = latch();
  const peek = bus.peek.bind(bus);
  vi.spyOn(bus, 'peek').mockImplementationOnce(async name => {
    const result = await peek(name);
    expect(result).toBeUndefined();
    emptyRead.resolve(); await releaseRead.promise;
    return result;
  });
  const running = main.run('initial');
  await emptyRead.promise;
  const receipt = await runtime.clientFor('main').sendMessage({ sender: 'main', target: 'main', content: 'late' });
  releaseRead.resolve();
  await running;
  expect(runs).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(999);
  expect(runs).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  await mainIdle();
  expect(runs.slice(1).map(r => event(r.input).id)).toEqual([receipt.id]);
  expect(await disk('main')).toBe('');
});

it.each([
  { teammates: [{ name: 'a', prompt: 'valid' }, { name: 'b', prompt: ' ' }] },
  { teammates: [{ name: 'a', prompt: 'one' }, { name: 'a', prompt: 'duplicate' }] },
  { teammates: [{ name: 'a', prompt: 'valid' }], extra: true },
])('returns invalid spawn arguments to the model without partial registration, then accepts a corrected batch: %j', async invalid => {
  const register = vi.spyOn(bus, 'register');
  let attempt = 0;
  model = async request => {
    if (actor(request) !== 'main') return answer();
    if (attempt++ === 0) return calls(call('spawn_teammates', invalid, 'invalid'));
    if (attempt === 2) {
      expect(JSON.parse(String(request.messages.at(-1)!.content))).toHaveProperty('error');
      expect(register).not.toHaveBeenCalled();
      expect(runtime.status()).toEqual([]);
      return calls(call('spawn_teammates', { teammates: [{ name: 'a', prompt: 'corrected' }] }, 'corrected'));
    }
    return answer();
  };
  await main.run('spawn');
  await idle('a');
  expect(register.mock.calls).toEqual([['a']]);
  expect(runs.map(r => r.input)).toEqual(['spawn', 'corrected']);
  expect(history.filter(m => m.role === 'tool').map(m => JSON.parse(String(m.content))))
    .toMatchObject([{ error: expect.any(String) }, { teammates: [{ name: 'a' }] }]);
});

it.each(['model', 'corrupt-jsonl'])('isolates %s failure, preserves unread bytes and never retries the failed agent', async failure => {
  const entered = latch(); const finish = latch();
  model = async request => {
    if (actor(request) === 'a') {
      if (inputs(request.messages).at(-1) === 'initial') { entered.resolve(); await finish.promise; }
      else throw new Error('injected model failure');
    }
    return answer();
  };
  await runtime.spawnTeammates({ teammates: [{ name: 'a', prompt: 'initial' }, { name: 'b', prompt: 'healthy' }] });
  await entered.promise; await idle('b');
  const first = await runtime.clientFor('main').sendMessage({ sender: 'main', target: 'a', content: 'bad' });
  await runtime.clientFor('main').sendMessage({ sender: 'main', target: 'a', content: 'unread' });
  if (failure === 'corrupt-jsonl') await fs.appendFile(inboxPath(workspace, 'a'), '{');
  const before = await disk('a');
  finish.resolve();
  await settled(() => runtime.status()[0].state === 'stopped');
  expect(runtime.status()[0].error).toMatchObject({ phase: failure === 'model' ? 'model' : 'storage' });
  expect(bus.error('a')).toMatchObject(failure === 'model'
    ? { code: 'CONSUMER_FAILED', messageId: first.id } : { code: 'STORAGE', cause: { code: 'CORRUPT' } });
  expect(await disk('a')).toBe(before);
  const failedRuns = runs.filter(r => r.logPrefix === '[teammate:a]').length;
  expect(failedRuns).toBe(failure === 'model' ? 2 : 1);
  await runtime.clientFor('main').sendMessage({ sender: 'main', target: 'b', content: 'still healthy' });
  await vi.advanceTimersByTimeAsync(1000);
  await idle('b');
  expect(await disk('b')).toBe('');
  expect(vi.getTimerCount()).toBe(1); // only healthy b polls
  await vi.advanceTimersByTimeAsync(5000);
  await idle('b');
  expect(runs.filter(r => r.logPrefix === '[teammate:a]')).toHaveLength(failedRuns);
  expect(await disk('a')).toBe(before);
});

it('acknowledges the active model turn on shutdown but preserves later deliveries and rejects new work', async () => {
  const entered = latch(); const finish = latch();
  model = async () => { entered.resolve(); await finish.promise; return answer(); };
  const first = await runtime.clientFor('main').sendMessage({ sender: 'main', target: 'main', content: 'active' });
  main.start();
  await vi.advanceTimersByTimeAsync(1000);
  await entered.promise;
  expect(vi.getTimerCount()).toBe(0);
  const unread = await runtime.clientFor('main').sendMessage({ sender: 'main', target: 'main', content: 'unread' });
  const queued = main.run('queued user');
  const rejected = expect(queued).rejects.toThrow('停止');
  const stopping = runtime.stop();
  expect(runtime.stop()).toBe(stopping);
  await expect(runtime.clientFor('main').sendMessage({ sender: 'main', target: 'main', content: 'too late' })).rejects.toThrow('停止');
  expect(() => runtime.runTurn('main', 'too late')).toThrow('停止');
  finish.resolve();
  await stopping; await rejected;
  expect(runs.map(r => event(r.input).id)).toEqual([first.id]);
  expect(JSON.parse(await disk('main'))).toMatchObject({ id: unread.id, content: 'unread' });
  main.start(); main.tick();
  await vi.advanceTimersByTimeAsync(5000);
  expect(runs).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
  const reopened = await MessageBus.open(workspace);
  try {
    await expect(reopened.register('main')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', messageId: unread.id });
    await reopened.register('main', { recover: true });
    expect((await reopened.peek('main'))?.id).toBe(unread.id);
  } finally { await reopened.close(); }
});
