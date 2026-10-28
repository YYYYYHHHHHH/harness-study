import type OpenAI from 'openai';
import type { ChatCompletionMessageParam as Message } from 'openai/resources/chat/completions';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('js-tiktoken', () => ({
  encodingForModel: () => ({ encode: (text: string) => ({ length: text.length }) }),
  getEncoding: () => ({ encode: (text: string) => ({ length: text.length }) }),
}));
vi.mock('../src/skills/index.js', () => ({ scanSkills: async () => new Map(), buildSkillsPrompt: () => '' }));
vi.mock('../src/permissions/index.js', () => ({ checkPermission: async () => ({ allowed: true }) }));
vi.mock('ora', () => ({ default: () => ({ start() { return this; }, stop() {}, fail() {}, succeed() {}, warn() {} }) }));
import { runAgent } from '../src/agent.js';
import type { BackgroundTaskMap } from '../src/background-tasks.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'harness-context-snapshots-'));
  vi.spyOn(process, 'cwd').mockReturnValue(directory);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubEnv('OPENAI_CONTEXT_WINDOW_TOKENS', '100000');
  vi.stubEnv('OPENAI_MAX_OUTPUT_TOKENS', '1000');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

const answer = { choices: [{ message: { role: 'assistant', content: '完成' } }] };
const toolCall = { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
  { id: 'call-1', type: 'function', function: { name: 'example', arguments: '{}' } },
] } }] };
function options(create: ReturnType<typeof vi.fn>, messages: Message[] = []) {
  return {
    client: { chat: { completions: { create } } } as unknown as OpenAI,
    model: 'test', input: '执行任务', systemPrompt: 'system', messages, memory: false as const,
    tools: [{ schema: { type: 'function' as const, function: { name: 'example' } }, handler: async () => '工具结果\n中文' }],
  };
}
const snapshotsRoot = () => join(directory, '.context', 'messages');
const readSnapshot = async (runId: string, round: string) =>
  JSON.parse(await readFile(join(snapshotsRoot(), runId, `round-${round}.json`), 'utf8')) as Message[];

it('saves complete tool batches before the next request, final replies, and background notifications', async () => {
  const bg_task_map: BackgroundTaskMap = new Map([['bg-1', {
    bg_task_id: 'bg-1', command: 'example', started_at: Date.now(), status: 'completed',
    result: '<finished>', origin_tool_id: 'previous-call', notified: false,
  }]]);
  let firstSnapshot: Message[] = [];
  let runId = '';
  const create = vi.fn().mockResolvedValueOnce(toolCall).mockImplementationOnce(async () => {
    [runId] = await readdir(snapshotsRoot());
    firstSnapshot = await readSnapshot(runId, '0001');
    expect(firstSnapshot.map(message => message.role)).toEqual(['system', 'user', 'user', 'assistant', 'tool']);
    expect(firstSnapshot[2].content).toContain('<task_result>&lt;finished&gt;</task_result>');
    expect(firstSnapshot.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call-1', content: '工具结果\n中文' });
    return answer;
  });
  const config = options(create);
  await expect(runAgent({ ...config, bg_task_map })).resolves.toMatchObject({ rounds: 2, finished: true });
  expect(await readdir(join(snapshotsRoot(), runId))).toEqual(['round-0001.json', 'round-0002.json']);
  expect(await readSnapshot(runId, '0001')).toEqual(firstSnapshot);
  expect(await readSnapshot(runId, '0002')).toEqual(config.messages);
  expect(config.messages.at(-1)).toEqual(answer.choices[0].message);
});

it('gives subsequent turns independent directories while preserving shared history in each snapshot', async () => {
  const config = options(vi.fn().mockResolvedValue(answer));
  await runAgent(config);
  const [firstRun] = await readdir(snapshotsRoot());
  const original = await readSnapshot(firstRun, '0001');
  await runAgent({ ...config, input: '追问' });
  const runs = await readdir(snapshotsRoot());
  expect(runs).toHaveLength(2);
  const secondRun = runs.find(run => run !== firstRun)!;
  expect(await readSnapshot(secondRun, '0001')).toEqual(config.messages);
  expect(await readSnapshot(firstRun, '0001')).toEqual(original);
  expect(original).toHaveLength(3);
  expect(config.messages).toHaveLength(5);
});

it('saves partial context when a model request fails without replacing the original error', async () => {
  const failure = new Error('model unavailable');
  const config = options(vi.fn().mockResolvedValueOnce(toolCall).mockRejectedValueOnce(failure));
  await expect(runAgent(config)).rejects.toBe(failure);
  const [runId] = await readdir(snapshotsRoot());
  expect(await readdir(join(snapshotsRoot(), runId))).toEqual(['round-0001.json', 'round-0002.json']);
  expect(await readSnapshot(runId, '0002')).toEqual(config.messages);
});

it.each([false, true])('reports a snapshot write failure without changing the agent outcome (model fails: %s)', async fails => {
  // A file at the required directory produces a real filesystem failure.
  await writeFile(join(directory, '.context'), 'blocked');
  const failure = new Error('original model error');
  const create = fails ? vi.fn().mockRejectedValue(failure) : vi.fn().mockResolvedValue(answer);
  const execution = runAgent(options(create));
  if (fails) await expect(execution).rejects.toBe(failure);
  else await expect(execution).resolves.toMatchObject({ finished: true, finalContent: '完成' });
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('第 1 轮上下文保存失败'));
});
