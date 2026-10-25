import type OpenAI from 'openai';
import type { ChatCompletionMessageParam as Message } from 'openai/resources/chat/completions';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

vi.mock('js-tiktoken', () => ({
  encodingForModel: () => ({ encode: (text: string) => ({ length: text.length }) }),
  getEncoding: () => ({ encode: (text: string) => ({ length: text.length }) }),
}));
vi.mock('../src/skills/index.js', () => ({ scanSkills: async () => new Map(), buildSkillsPrompt: () => '' }));
vi.mock('../src/permissions/index.js', () => ({ checkPermission: async () => ({ allowed: true }) }));
vi.mock('ora', () => ({ default: () => ({ start() { return this; }, stop() {}, fail() {}, succeed() {} }) }));
import { runAgent } from '../src/agent.js';
import { MemoryManager, MemoryStore, type MemoryDraft } from '../src/memory/index.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'harness-agent-memory-'));
  vi.spyOn(process, 'cwd').mockReturnValue(directory);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubEnv('OPENAI_CONTEXT_WINDOW_TOKENS', '100000');
  vi.stubEnv('OPENAI_MAX_OUTPUT_TOKENS', '1000');
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const remembered: MemoryDraft = { name: '语言偏好', description: '回答与代码注释使用中文', type: 'user', body: '用户偏好中文。' };
const answer = (content: string) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const toolCall = () => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
  { id: 'call', type: 'function', function: { name: 'example', arguments: '{}' } },
] }, finish_reason: 'tool_calls' }] });
const isMemory = (message: Message) => typeof message.content === 'string' && message.content.startsWith('[本轮参考记忆]');

it.each(['proactive', 'overflow'])('keeps the turn anchor and original transcript through %s compression and tool loops', async mode => {
  const store = new MemoryStore(join(directory, '.memory'));
  await store.update(async () => [remembered]);
  const [entry] = await store.read();
  const mainRequests: Message[][] = [];
  const extraction: string[] = [];
  let mainCalls = 0;
  const create = vi.fn(async (request: { messages: Message[] }) => {
    const system = request.messages[0].content as string;
    if (system.includes('[memory:select]')) return answer(JSON.stringify([entry.filename]));
    if (system.includes('[memory:extract]')) {
      extraction.push(request.messages[1].content as string);
      return answer('[]');
    }
    if (system.includes('[memory:consolidate]')) return answer(JSON.stringify([remembered]));
    if (request.messages.some(message => message.role === 'system' && String(message.content).includes('压缩 agent'))) {
      return answer('已读取项目数据，保留用户目标并继续。');
    }
    mainRequests.push(request.messages);
    mainCalls++;
    if (mainCalls === 1) return toolCall();
    if (mode === 'overflow' && mainCalls === 2) throw { code: 'context_length_exceeded' };
    return answer('完成');
  });
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  const input = '当前用户请求';
  const messages: Message[] = mode === 'proactive'
    ? [{ role: 'system', content: 'system' }, { role: 'user', content: '旧历史'.repeat(30000) }]
    : [];
  const memory = new MemoryManager({ client, model: 'test' });
  const originalToolResult = '原始证据-' + 'x'.repeat(mode === 'proactive' ? 60000 : 10000) + '-最后的事实';
  const handler = vi.fn(async () => originalToolResult);
  await expect(runAgent({ client, model: 'test', input, systemPrompt: 'system', messages, memory,
    tools: [{ schema: { type: 'function', function: { name: 'example' } }, handler }],
  })).resolves.toMatchObject({ finished: true, finalContent: '完成' });
  expect(handler).toHaveBeenCalledTimes(1);
  for (const request of mainRequests) {
    const anchor = request.findIndex(message => message.role === 'user' && message.content === input);
    expect(anchor).toBeGreaterThanOrEqual(0);
    expect(isMemory(request[anchor + 1])).toBe(true);
    expect(request.filter(isMemory)).toHaveLength(1);
  }
  expect(messages.some(isMemory)).toBe(false);
  expect(extraction.join('')).toContain(originalToolResult);
  expect(extraction.join('')).toContain('完成');
  expect(extraction.join('')).not.toContain('[本轮参考记忆]');
});

it('loads persisted memory on a later turn and reuses recent real user inputs by default', async () => {
  const mainRequests: Message[][] = [];
  const selections: string[][] = [];
  const create = vi.fn(async (request: { messages: Message[] }) => {
    const system = request.messages[0].content as string;
    if (system.includes('[memory:select]')) {
      const data = JSON.parse(request.messages[1].content as string);
      selections.push(data.recent_user_inputs);
      return answer(JSON.stringify([data.catalog[0].filename]));
    }
    if (system.includes('[memory:extract]') || system.includes('[memory:consolidate]')) return answer(JSON.stringify([remembered]));
    mainRequests.push(request.messages);
    return answer('好的');
  });
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  const messages: Message[] = [];
  const options = { client, model: 'test', systemPrompt: 'system', tools: [], messages };
  await runAgent({ ...options, input: '以后请用中文' });
  // Simulate history compaction between user turns. Selection must not use this summary.
  messages.splice(1, messages.length - 1, { role: 'user', content: '[历史对话摘要]' });
  await runAgent({ ...options, input: '帮我写脚本' });
  expect(selections).toEqual([['以后请用中文', '帮我写脚本']]);
  expect(mainRequests[0].some(isMemory)).toBe(false);
  expect(mainRequests[1].filter(isMemory)).toHaveLength(1);
  expect(messages.some(isMemory)).toBe(false);
});

it('continues the answer on memory failures, but does not extract after a failed main call', async () => {
  const create = vi.fn().mockResolvedValue(answer('完成'));
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  const memory = new MemoryManager({ client, model: 'test' });
  vi.spyOn(memory, 'load_memory').mockRejectedValue(new Error('selection failed'));
  const finish = vi.spyOn(memory, 'finishTurn').mockRejectedValue(new Error('extraction failed'));
  const options = { client, model: 'test', input: 'task', systemPrompt: 'system', tools: [], memory };
  await expect(runAgent(options)).resolves.toMatchObject({ finished: true });
  expect(console.warn).toHaveBeenCalledTimes(2);
  expect(finish).toHaveBeenCalledTimes(1);
  create.mockRejectedValue(new Error('main failed'));
  await expect(runAgent(options)).rejects.toThrow('main failed');
  expect(finish).toHaveBeenCalledTimes(1);
});
