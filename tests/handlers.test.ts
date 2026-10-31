import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/agent.js', () => ({ runAgent: vi.fn() }));
import { runAgent } from '../src/agent.js';
import { tools } from '../src/tools/index.js';
import { dispatchTool, type ToolContext } from '../src/tools/dispatch.js';
import { runBash, runEdit, runGlob, runRead, runSpawnSubagent, runTodoWrite, runWrite } from '../src/tools/handlers.js';
import type { BackgroundTaskMap } from '../src/background-tasks.js';

const context: ToolContext = {
  client: {} as OpenAI, model: 'test-model', tools, logPrefix: '[test]', runId: 'test', skills: new Map(),
};
let dir: string;
let log: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'harness-tools-'));
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.mocked(runAgent).mockReset();
});
const dispatch = (name: string, args: unknown) => dispatchTool(name, JSON.stringify(args), context);

describe('filesystem handlers (real temporary files)', () => {
  it('writes UTF-8 bytes and reads whole or limited files through dispatch', async () => {
    const path = join(dir, 'file.txt');
    const content = '中文\nsecond\nthird';
    expect(await dispatch('write_file', { path, content })).toBe(`Wrote ${Buffer.byteLength(content)} bytes to ${path}`);
    expect(await dispatch('read_file', { path })).toBe(content);
    expect(await dispatch('read_file', { path: relative(process.cwd(), path), limit: 2 })).toBe('中文\nsecond');
    expect(await runRead(path, 0)).toBe('');
  });
  it('edits only the first occurrence and leaves unmatched content untouched', async () => {
    const path = join(dir, 'edit.txt');
    await runWrite(path, 'old old');
    expect(await dispatch('edit_file', { path, old_text: 'old', new_text: 'new' })).toBe(`Edited ${path}`);
    expect(await readFile(path, 'utf8')).toBe('new old');
    expect(await runEdit(path, 'absent', 'changed')).toBe('Error: text not found');
    expect(await runRead(path)).toBe('new old');
  });
  it('propagates filesystem failures', async () => {
    const missing = join(dir, 'missing', 'file.txt');
    await expect(dispatch('read_file', { path: missing })).rejects.toThrow(/ENOENT/);
    await expect(dispatch('write_file', { path: missing, content: 'x' })).rejects.toThrow(/ENOENT/);
    await expect(runEdit(missing, 'a', 'b')).rejects.toThrow(/ENOENT/);
  });
  it('finds files relative to WORKDIR and reports empty matches', async () => {
    await runWrite(join(dir, 'a.txt'), 'a');
    await runWrite(join(dir, 'b.txt'), 'b');
    const pattern = `${relative(process.cwd(), dir)}/*.txt`;
    const matches = (await dispatch('glob', { pattern })).split('\n').sort();
    expect(matches).toEqual(['a.txt', 'b.txt'].map(name => join(relative(process.cwd(), dir), name)).sort());
    expect(await runGlob(`${relative(process.cwd(), dir)}/*.missing`)).toBe('(no matches)');
  });
});

it('executes local commands, combines streams, handles empty output and nonzero exits', async () => {
  const node = JSON.stringify(process.execPath);
  expect(await dispatch('bash', { command: `${node} -e "process.stdout.write('out');process.stderr.write('err')"` })).toBe('outerr');
  expect(await runBash(`${node} -e ""`)).toBe('(no output)');
  expect(await runBash(`${node} -e "process.stdout.write('x'.repeat(50001))"`)).toHaveLength(50000);
  expect(await runBash(`${node} -e "process.exit(2)"`)).toMatch(/^Error: Command failed:/);
  expect(await dispatch('bash', { command: 'printf foreground', is_slow: false })).toBe('foreground');
});

it.each([
  ['printf background', 'completed', 'background'],
  ['printf failure >&2; exit 2', 'failed', 'failure'],
])('executes background commands through dispatch: %s', async (command, status, output) => {
  const bg_task_map: BackgroundTaskMap = new Map();
  const response = await dispatchTool('bash', JSON.stringify({ command, is_slow: true }), {
    ...context, bg_task_map, toolCallId: 'background-call',
  });
  const [task] = [...bg_task_map.values()];
  expect(response).toBe(`[任务已在后台执行中]bgid：${task.bg_task_id}`);
  expect(task.status).toBe('running');
  await vi.waitFor(() => expect(task.status).toBe(status));
  expect(task.result).toContain(output);
  expect(task.origin_tool_id).toBe('background-call');
});

it('renders each TODO status and returns structured data with and without prefix', async () => {
  const todos = [
    { content: 'pending', status: '未开始' as const },
    { content: 'active', status: '进行中' as const },
    { content: 'done', status: '已完成' as const },
  ];
  expect(JSON.parse(await dispatch('todo_write', { todos }))).toEqual({ ok: true, count: 3, todos });
  expect(log.mock.calls.flat().join('\n')).toContain('[test]');
  for (const status of todos.map(todo => todo.status)) expect(log.mock.calls.flat().join('\n')).toContain(status);
  expect(JSON.parse(await runTodoWrite([]))).toEqual({ ok: true, count: 0, todos: [] });
});

it.each([
  ['bash', {}, /command 参数无效/],
  ['bash', { command: 'echo test', is_slow: 'true' }, /is_slow 参数必须是布尔值/],
  ['bash', { command: 'echo test', is_slow: null }, /is_slow 参数必须是布尔值/],
  ['bash', { command: 'echo test', is_slow: true }, /后台 bash 需要/],
  ['read_file', { path: 1 }, /path 参数无效/],
  ['read_file', { path: 'x', limit: '2' }, /limit 参数必须是数字/],
  ['write_file', { path: 'x', content: null }, /content 参数无效/],
  ['edit_file', { path: 'x', old_text: 1, new_text: 'x' }, /old_text 参数无效/],
  ['edit_file', { path: 'x', old_text: 'x', new_text: false }, /new_text 参数无效/],
  ['glob', { pattern: 2 }, /pattern 参数无效/],
  ['load_skill', { name: 2 }, /name 参数无效/],
  ['load_skill', { name: ' ' }, /name 必须是非空字符串/],
  ['load_skill', { name: 'missing' }, /未找到 skill：missing/],
  ['todo_write', { todos: {} }, /todos 参数必须是数组/],
  ['todo_write', { todos: [null] }, /todos\[0\] 不是对象/],
  ['todo_write', { todos: [2] }, /todos\[0\] 不是对象/],
  ['todo_write', { todos: [{ content: 1, status: '未开始' }] }, /content 必须是字符串/],
  ['todo_write', { todos: [{ content: 'x', status: 'bad' }] }, /status 必须是/],
  ['todo_write', { todos: [{ content: 'x', status: 1 }] }, /status 必须是/],
  ['spawn_subagent', { subagent_name: 1, task: 'x' }, /subagent_name 参数无效/],
  ['spawn_subagent', { subagent_name: 'x', task: null }, /task 参数无效/],
])('validates %s arguments (%j)', async (name, args, error) => {
  await expect(dispatch(name, args)).rejects.toThrow(error);
});

describe('subagent orchestration (mocked agent, no LLM/network)', () => {
  it('passes context and task while preventing recursive subagent spawning', async () => {
    vi.mocked(runAgent).mockResolvedValue({ finished: true, finalContent: '  done  ', rounds: 2 });
    expect(await dispatch('spawn_subagent', { subagent_name: 'worker', task: 'task' })).toBe('done');
    const options = vi.mocked(runAgent).mock.calls[0]![0];
    expect(options).toMatchObject({ client: context.client, model: context.model, input: 'task' });
    expect(options.tools).toEqual(tools.filter(tool => !['spawn_subagent', 'spawn_teammates', 'send_message'].includes(tool.schema.function.name)));
    expect(options.systemPrompt).toContain('worker');
    expect(options.systemPrompt).toContain(process.cwd());
    expect(options.systemPrompt).not.toContain('、spawn_subagent');
    // Preserve the user's removal of the hardcoded ten-round limit.
    expect(options).not.toHaveProperty('maxRounds');
  });
  it('shares the scheduling service with a subagent', async () => {
    vi.mocked(runAgent).mockResolvedValue({ finished: true, finalContent: 'done', rounds: 1 });
    const cron = { create: vi.fn(), cancel: vi.fn(), list: vi.fn(), take: vi.fn(), finish: vi.fn() };
    await runSpawnSubagent('worker', 'task', { ...context, cron });
    expect(vi.mocked(runAgent).mock.calls[0][0].cron).toBe(cron);
  });
  it('does not inherit team tools when the parent later registers them', async () => {
    vi.mocked(runAgent).mockResolvedValue({ finished: true, finalContent: 'done', rounds: 1 });
    const teamTools = ['spawn_teammates', 'send_message'].map(name => ({
      schema: { type: 'function' as const, function: { name } }, handler: vi.fn(),
    }));
    await runSpawnSubagent('worker', 'task', { ...context, tools: [...tools, ...teamTools] });
    const options = vi.mocked(runAgent).mock.calls[0][0];
    expect(options.tools).toEqual(tools.filter(tool => !['spawn_subagent', 'spawn_teammates', 'send_message'].includes(tool.schema.function.name)));
    expect(options.systemPrompt).not.toContain('spawn_teammates');
    expect(options.systemPrompt).not.toContain('send_message');
    expect(options.team).toBeUndefined();
    expect(options.memory).toBe(false);
    expect(options.agentId).toMatch(/^subagent:worker:/);
  });
  it('reports unfinished runs', async () => {
    vi.mocked(runAgent).mockResolvedValue({ finished: false, finalContent: null, rounds: 50 });
    expect(JSON.parse(await runSpawnSubagent('worker', 'task', context))).toEqual({
      ok: false, error: 'subagent「worker」未完成任务（已执行 50 轮）',
    });
  });
  it.each([null, '   '])('uses a fallback for an empty summary (%s)', async finalContent => {
    vi.mocked(runAgent).mockResolvedValue({ finished: true, finalContent, rounds: 1 });
    expect(await runSpawnSubagent('worker', 'task', context)).toBe('(subagent 未返回总结)');
  });
  it('returns a long summary without truncating the result', async () => {
    vi.mocked(runAgent).mockResolvedValue({ finished: true, finalContent: 'x'.repeat(121), rounds: 1 });
    expect(await runSpawnSubagent('worker', 'task', context)).toBe('x'.repeat(121));
    expect(log.mock.calls.flat().join('\n')).toContain('…');
  });
  it('propagates agent failures', async () => {
    vi.mocked(runAgent).mockRejectedValue(new Error('agent failed'));
    await expect(runSpawnSubagent('worker', 'task', context)).rejects.toThrow('agent failed');
  });
});
