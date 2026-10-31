import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('js-tiktoken', () => ({
  encodingForModel: () => ({ encode: (text: string) => ({ length: text.length }) }),
  getEncoding: () => ({ encode: (text: string) => ({ length: text.length }) }),
}));
vi.mock('../src/skills/index.js', () => ({ scanSkills: async () => new Map(), buildSkillsPrompt: () => '' }));
vi.mock('../src/permissions/index.js', () => ({ checkPermission: async () => ({ allowed: true }) }));
vi.mock('ora', () => ({ default: () => ({ start() { return this; }, stop() {}, fail() {}, succeed() {} }) }));
import { runAgent } from '../src/agent.js';
import { AgentTurns } from '../src/agent-turns.js';
import { CronConsumer } from '../src/cron/consumer.js';
import { CronEngine } from '../src/cron/engine.js';
import type { CronJobService } from '../src/cron/types.js';
import { tools } from '../src/tools/index.js';

afterEach(() => { vi.restoreAllMocks(); });

it('creates a job through runAgent tool context and injects its prompt into the shared conversation on consumption', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const directory = mkdtempSync(join(tmpdir(), 'harness-agent-cron-'));
  let now = Date.now();
  const engine = new CronEngine(directory, () => now);
  const cron: CronJobService = {
    create: async args => engine.create(args), cancel: async id => engine.cancel(id), list: async () => engine.list(),
    take: async () => engine.take(), finish: async id => engine.finish(id),
  };
  const prompt = '执行定时检查';
  const create = vi.fn()
    .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
      id: 'cron-call', type: 'function', function: { name: 'create_cron_job', arguments: JSON.stringify({
        prompt, drauble: true, recurring: false, cron: '* * * * * *',
      }) },
    }] } }] })
    .mockResolvedValue({ choices: [{ message: { role: 'assistant', content: '完成' } }] });
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  const messages: ChatCompletionMessageParam[] = [];
  const turns = new AgentTurns();
  const execute = async (input: string) => {
    await runAgent({ client, model: 'test', input, systemPrompt: 'system', tools, messages, memory: false, cron });
  };
  const onError = vi.fn();
  const consumer = new CronConsumer(cron, turns, job => execute(job.prompt), onError);
  try {
    await turns.run(() => execute('安排定时任务'));
    expect(engine.list()).toHaveLength(1);
    expect(messages.some(message => message.role === 'tool' && String(message.content).includes('"ok":true'))).toBe(true);
    now += 1000;
    engine.tick();
    consumer.tick();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(3));
    await consumer.stop();
    expect(onError).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(3);
    expect(messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['安排定时任务', prompt]);
    expect(engine.list()).toEqual([]);
  } finally {
    await consumer.stop();
    engine.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
