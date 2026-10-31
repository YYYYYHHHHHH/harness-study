import type OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('js-tiktoken', () => ({
  encodingForModel: () => ({ encode: (text: string) => ({ length: text.length }) }),
  getEncoding: () => ({ encode: (text: string) => ({ length: text.length }) }),
}));
vi.mock('../src/skills/index.js', () => ({ scanSkills: async () => new Map(), buildSkillsPrompt: () => '' }));
vi.mock('../src/permissions/index.js', () => ({ checkPermission: async () => ({ allowed: true }) }));
vi.mock('../src/context-snapshots.js', () => ({ saveContextSnapshot: vi.fn() }));
vi.mock('ora', () => ({ default: () => ({ start() { return this; }, stop() {}, fail() {}, succeed() {}, warn() {} }) }));
import { runAgent } from '../src/agent.js';
import { tools } from '../src/tools/index.js';
import type { AgentTeamClient } from '../src/agent-team/types.js';

afterEach(() => vi.restoreAllMocks());

it.each(['main', 'teammate'] as const)('passes the bound team client and restricts both schemas and dispatch for %s', async role => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const team: AgentTeamClient = { spawnTeammates: vi.fn().mockResolvedValue({ teammates: [] }), sendMessage: vi.fn().mockResolvedValue({ id: 'sent' }) };
  const messages: ChatCompletionMessageParam[] = [];
  const advertised: string[][] = [];
  const forbidden = ['create_tasks', 'clamic_task', 'get_tasks_detail', 'complate_tasks',
    'create_cron_job', 'cancel_cron_job', 'list_cron_job', 'spawn_subagent', 'spawn_teammates'];
  let round = 0;
  const create = vi.fn(async (request: { tools: ChatCompletionFunctionTool[] }) => {
    advertised.push(request.tools.map(t => t.function.name));
    if (round++ > 0) return { choices: [{ message: { role: 'assistant', content: 'done' } }] };
    const calls = [
      { name: 'send_message', args: { sender: role === 'main' ? 'main' : 'writer', target: 'main', content: 'hello' } },
      ...(role === 'main' ? [{ name: 'spawn_teammates', args: { teammates: [{ name: 'writer', prompt: 'work' }] } }]
        : forbidden.map(name => ({ name, args: {} }))),
    ];
    return { choices: [{ message: { role: 'assistant', content: null, tool_calls: calls.map(({ name, args }, i) => ({
      id: `call-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) },
    })) } }] };
  });
  const result = await runAgent({ client: { chat: { completions: { create } } } as unknown as OpenAI,
    model: 'test', input: 'work', systemPrompt: 'test', tools, messages, role, team, memory: false });
  expect(result.finished).toBe(true);
  expect(team.sendMessage).toHaveBeenCalledTimes(1);
  expect(advertised.every(names => names.includes('send_message'))).toBe(true);
  if (role === 'teammate') {
    expect(advertised.every(names => forbidden.every(name => !names.includes(name)))).toBe(true);
    expect(team.spawnTeammates).not.toHaveBeenCalled();
    const results = messages.filter(m => m.role === 'tool');
    expect(results.slice(1).every(m => String(m.content).includes('未启用工具'))).toBe(true);
    expect(results).toHaveLength(10);
  } else {
    expect(advertised[0]).toEqual(tools.map(t => t.schema.function.name));
    expect(team.spawnTeammates).toHaveBeenCalledWith({ teammates: [{ name: 'writer', prompt: 'work' }] });
  }
});
