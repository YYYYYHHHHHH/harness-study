import type OpenAI from 'openai';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

vi.mock('js-tiktoken', () => ({
  encodingForModel: () => ({ encode: (text: string) => ({ length: text.length }) }),
  getEncoding: () => ({ encode: (text: string) => ({ length: text.length }) }),
}));
vi.mock('../src/skills/index.js', () => ({ scanSkills: async () => new Map(), buildSkillsPrompt: () => '' }));
vi.mock('../src/permissions/index.js', () => ({ checkPermission: async () => ({ allowed: true }) }));
import { runAgent } from '../src/agent.js';
import { L2_MARKER } from '../src/context-compression.js';

const answer = (content: string) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const toolCall = () => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
  { id: 'call', type: 'function', function: { name: 'example', arguments: '{}' } },
] }, finish_reason: 'tool_calls' }] });
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'harness-agent-context-'));
  vi.spyOn(process, 'cwd').mockReturnValue(directory);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubEnv('OPENAI_CONTEXT_WINDOW_TOKENS', '100000');
  vi.stubEnv('OPENAI_MAX_OUTPUT_TOKENS', '1000');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
function options(create: ReturnType<typeof vi.fn>, handler = vi.fn(async () => 'done')) {
  return { client: { chat: { completions: { create } } } as unknown as OpenAI,
    model: 'test', input: 'Complete the task. ' + 'x'.repeat(1000), systemPrompt: 'Keep constraints.',
    tools: [{ schema: { type: 'function' as const, function: { name: 'example' } }, handler }] };
}

it('compresses before the next model request, sets max output, and does not pay for L1/L2', async () => {
  const create = vi.fn().mockResolvedValueOnce(toolCall()).mockResolvedValueOnce(answer('finished'));
  const handler = vi.fn(async () => 'data '.repeat(12000));
  await expect(runAgent(options(create, handler))).resolves.toMatchObject({ finished: true, rounds: 2 });
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1][0].messages.at(-1).content).toContain(L2_MARKER);
  expect(create.mock.calls[1][0].max_completion_tokens).toBe(1000);
  expect(await readdir(join(directory, '.context/tool-results'))).toHaveLength(1);
});

it('summarizes a context error then retries the same round without re-running tools', async () => {
  const create = vi.fn().mockResolvedValueOnce(toolCall())
    .mockRejectedValueOnce({ code: 'context_length_exceeded' })
    .mockResolvedValueOnce(answer('用户目标：完成任务；工具已执行成功，继续完成最终答复。'))
    .mockResolvedValueOnce(answer('finished'));
  const handler = vi.fn(async () => 'result '.repeat(1000));
  await expect(runAgent(options(create, handler))).resolves.toMatchObject({ finalContent: 'finished', rounds: 2 });
  expect(handler).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledTimes(4);
  expect(create.mock.calls[2][0]).not.toHaveProperty('tools');
  expect(create.mock.calls[3][0].messages).toHaveLength(2);
  expect(create.mock.calls[3][0].messages[0]).toEqual({ role: 'system', content: 'Keep constraints.' });
  expect(create.mock.calls[3][0].messages[1].content).toContain('[历史对话摘要]');
});

it('runs beyond the previous 50 round cap', async () => {
  let rounds = 0;
  const create = vi.fn(async () => ++rounds <= 55 ? toolCall() : answer('finished'));
  const handler = vi.fn(async () => 'done');
  await expect(runAgent(options(create, handler))).resolves.toEqual({ finished: true, finalContent: 'finished', rounds: 56 });
  expect(handler).toHaveBeenCalledTimes(55);
});

it('does not retry non-context errors', async () => {
  const create = vi.fn().mockRejectedValue(new Error('rate limit exceeded'));
  await expect(runAgent(options(create))).rejects.toThrow('rate limit exceeded');
  expect(create).toHaveBeenCalledTimes(1);
});

it('stops failed context recovery when another summary makes no progress', async () => {
  const create = vi.fn().mockRejectedValueOnce({ code: 'context_length_exceeded' })
    .mockResolvedValueOnce(answer('compact'))
    .mockRejectedValueOnce({ code: 'context_length_exceeded' })
    .mockResolvedValueOnce(answer('compact'));
  await expect(runAgent(options(create))).rejects.toThrow('未缩短');
  expect(create).toHaveBeenCalledTimes(4);
});
