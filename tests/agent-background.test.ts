import type OpenAI from 'openai';
import type { ChatCompletionMessageParam as Message } from 'openai/resources/chat/completions';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('js-tiktoken', () => ({
  encodingForModel: () => ({ encode: (text: string) => ({ length: text.length }) }),
  getEncoding: () => ({ encode: (text: string) => ({ length: text.length }) }),
}));
vi.mock('../src/skills/index.js', () => ({ scanSkills: async () => new Map(), buildSkillsPrompt: () => '' }));
vi.mock('../src/permissions/index.js', () => ({ checkPermission: vi.fn(async () => ({ allowed: true })) }));
vi.mock('ora', () => ({ default: () => ({ start() { return this; }, stop() {}, fail() {}, succeed() {}, warn() {} }) }));
vi.mock('../src/tools/bash.js', () => ({ executeBash: vi.fn(), runBash: vi.fn() }));
import { runAgent } from '../src/agent.js';
import type { BackgroundTaskMap } from '../src/background-tasks.js';
import { executeBash, type BashResult } from '../src/tools/bash.js';
import { tools } from '../src/tools/index.js';
import { checkPermission } from '../src/permissions/index.js';
import { MemoryManager } from '../src/memory/index.js';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubEnv('OPENAI_CONTEXT_WINDOW_TOKENS', '100000');
  vi.stubEnv('OPENAI_MAX_OUTPUT_TOKENS', '1000');
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

const answer = (content = 'done') => ({ choices: [{ message: { role: 'assistant', content } }] });
const call = (id: string, name = 'bash', args: unknown = { command: 'slow command', is_slow: true }) => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
});
const calls = (...tool_calls: ReturnType<typeof call>[]) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls } }] });
const notifications = (messages: Message[]) => messages.filter(message =>
  message.role === 'user' && String(message.content).startsWith('<notify_bg_task>'));
function options(create: ReturnType<typeof vi.fn>, messages: Message[] = []) {
  return { client: { chat: { completions: { create } } } as unknown as OpenAI,
    model: 'test', input: 'task', systemPrompt: 'system', tools, messages, memory: false as const };
}

it('returns the bgid before completion and injects one notification after the entire tool batch', async () => {
  const pending = Promise.withResolvers<BashResult>();
  vi.mocked(executeBash).mockReturnValue(pending.promise);
  const bg_task_map: BackgroundTaskMap = new Map();
  const requests: Message[][] = [];
  const create = vi.fn(async (request: { messages: Message[] }) => {
    requests.push(structuredClone(request.messages));
    if (requests.length === 1) return calls(call('slow-1'), call('other-1', 'finish_background', {}));
    if (requests.length === 2) return calls(call('other-2', 'finish_background', {}));
    return answer();
  });
  const config = options(create);
  const memory = new MemoryManager({ client: config.client, model: 'test' });
  vi.spyOn(memory, 'load_memory').mockResolvedValue([]);
  const finish = vi.spyOn(memory, 'finishTurn').mockResolvedValue(undefined);
  await runAgent({ ...config, bg_task_map, memory, tools: [...tools, {
    schema: { type: 'function', function: { name: 'finish_background' } },
    handler: async () => {
      const [task] = [...bg_task_map.values()];
      expect(config.messages.some(message => message.role === 'tool' && message.content === `[任务已在后台执行中]bgid：${task.bg_task_id}`)).toBe(true);
      pending.resolve({ status: 'completed', result: '<done>&' });
      await pending.promise;
      return 'other result';
    },
  }] });
  expect(requests[1].slice(-3).map(message => message.role)).toEqual(['tool', 'tool', 'user']);
  expect(notifications(requests[1])).toHaveLength(1);
  expect(notifications(requests[1])[0].content).toContain('<task_result>&lt;done&gt;&amp;</task_result><origin_tool_id>slow-1</origin_tool_id>');
  expect(notifications(requests[2])).toHaveLength(1);
  expect(notifications(finish.mock.calls[0][0])).toEqual(notifications(config.messages));
  expect(executeBash).toHaveBeenCalledTimes(1);
});

it('processes completion during the final model response before ending the turn', async () => {
  const pending = Promise.withResolvers<BashResult>();
  vi.mocked(executeBash).mockReturnValue(pending.promise);
  const create = vi.fn().mockResolvedValueOnce(calls(call('slow')))
    .mockImplementationOnce(async (request: { messages: Message[] }) => {
      expect(notifications(request.messages)).toEqual([]);
      pending.resolve({ status: 'completed', result: 'finished during generation' });
      await pending.promise;
      return answer('early answer');
    }).mockImplementationOnce(async (request: { messages: Message[] }) => {
      expect(notifications(request.messages)).toHaveLength(1);
      return answer('answer with result');
    });
  await expect(runAgent(options(create))).resolves.toMatchObject({ finalContent: 'answer with result', rounds: 3 });
});

it('retains pending tasks across turns of the same history without leaking into another conversation', async () => {
  const pending = Promise.withResolvers<BashResult>();
  vi.mocked(executeBash).mockReturnValue(pending.promise);
  const create = vi.fn().mockResolvedValueOnce(calls(call('original'))).mockResolvedValue(answer());
  const config = options(create);
  await runAgent(config);
  expect(notifications(config.messages)).toEqual([]);
  pending.resolve({ status: 'failed', result: 'Error: command failed' });
  await pending.promise;
  const other = options(vi.fn().mockResolvedValue(answer()));
  await runAgent(other);
  expect(notifications(other.messages)).toEqual([]);
  await runAgent({ ...config, input: 'next turn' });
  expect(notifications(config.messages)).toHaveLength(1);
  expect(notifications(config.messages)[0].content).toContain('<origin_tool_id>original</origin_tool_id>');
  await runAgent({ ...config, input: 'third turn' });
  expect(notifications(config.messages)).toHaveLength(1);
});

it('does not start a background command when permission is denied', async () => {
  vi.mocked(checkPermission).mockResolvedValueOnce({ allowed: false, reason: 'denied' });
  const bg_task_map: BackgroundTaskMap = new Map();
  const create = vi.fn().mockResolvedValueOnce(calls(call('blocked'))).mockResolvedValue(answer());
  const config = options(create);
  await runAgent({ ...config, bg_task_map });
  expect(executeBash).not.toHaveBeenCalled();
  expect(bg_task_map.size).toBe(0);
  expect(config.messages).toContainEqual({ role: 'tool', tool_call_id: 'blocked', content: 'denied' });
});
