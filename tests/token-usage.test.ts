import type OpenAI from 'openai';
import type { CompletionUsage } from 'openai/resources/completions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextWindowTokens, DEFAULT_CONTEXT_WINDOW_TOKENS, formatUsage, TokenUsageTracker } from '../src/token-usage.js';

vi.mock('../src/skills/index.js', () => ({ scanSkills: vi.fn(async () => new Map()), buildSkillsPrompt: vi.fn(() => '') }));
vi.mock('../src/permissions/index.js', () => ({ checkPermission: vi.fn(async () => ({ allowed: true })) }));
import { runAgent } from '../src/agent.js';

const usage = (input: number, output: number): CompletionUsage => ({
  prompt_tokens: input, completion_tokens: output, total_tokens: input + output,
  prompt_tokens_details: { cached_tokens: 10, audio_tokens: 2 },
  completion_tokens_details: { reasoning_tokens: 3, accepted_prediction_tokens: 1 },
});
const response = (value?: CompletionUsage) => ({ choices: [{ message: { role: 'assistant', content: 'done' } }], usage: value });
const clientFor = (create: ReturnType<typeof vi.fn>) => ({ chat: { completions: { create } } }) as unknown as OpenAI;

beforeEach(() => { vi.stubEnv('OPENAI_CONTEXT_WINDOW_TOKENS', '1000'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('token usage accounting', () => {
  it('defaults to 1,050,000 tokens and validates overrides', () => {
    expect(contextWindowTokens({})).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(1_050_000);
    expect(contextWindowTokens({ OPENAI_CONTEXT_WINDOW_TOKENS: '4096' })).toBe(4096);
    for (const raw of ['', ' ', '0', '-2', '1.5', 'nope', 'Infinity', '9007199254740992']) {
      expect(() => contextWindowTokens({ OPENAI_CONTEXT_WINDOW_TOKENS: raw })).toThrow('正的安全整数');
    }
    for (const capacity of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new TokenUsageTracker(capacity)).toThrow('正的安全整数');
    }
  });

  it('calculates and displays context percentage against the default 1.05M capacity', () => {
    vi.stubEnv('OPENAI_CONTEXT_WINDOW_TOKENS', undefined);
    const tracker = new TokenUsageTracker();
    tracker.record(usage(500_000, 50));
    const snapshot = tracker.record(usage(12_400, 856));
    expect(snapshot.context).toEqual({ inputTokens: 12_400, capacityTokens: 1_050_000, percent: 12_400 / 1_050_000 * 100 });
    expect(formatUsage(snapshot).join('\n')).toContain('上下文 1.18% (12.4K / 1.1M)');
  });

  it('separates current prompt from cumulative spend and keeps detail subsets separate', () => {
    const tracker = new TokenUsageTracker(1000);
    tracker.record(usage(100, 50));
    const snapshot = tracker.record(usage(200, 20));
    expect(snapshot.single).toEqual({ input: 200, output: 20, total: 220, cached: 10, reasoning: 3 });
    expect(snapshot.cumulative).toEqual({ input: 300, output: 70, total: 370, cached: 20, reasoning: 6 });
    expect(snapshot.context).toEqual({ inputTokens: 200, capacityTokens: 1000, percent: 20 });
    expect(snapshot.promptDetails.audio_tokens).toBe(2);
    expect(snapshot.completionDetails.accepted_prediction_tokens).toBe(1);
    expect(formatUsage(snapshot)).toHaveLength(2);
    expect(formatUsage(snapshot).join('\n')).toContain('[main] tokens');
    const verbose = formatUsage(snapshot, '', true).join('\n');
    expect(verbose).toContain('input=200 output=20 total=220');
    expect(verbose).toContain('audio_tokens');
    expect(verbose).toContain('accepted_prediction_tokens');
  });

  it('missing or malformed usage is unknown, retaining only explicitly labelled known subtotal', () => {
    const tracker = new TokenUsageTracker(1000);
    tracker.record(usage(100, 50));
    const missing = tracker.record(undefined);
    expect(Object.values(missing.single)).toEqual([null, null, null, null, null]);
    expect(missing.context.percent).toBeNull();
    expect(missing.cumulative.total).toBeNull();
    const recovered = tracker.record(usage(200, 10));
    expect(recovered.cumulative.total).toBeNull();
    expect(recovered.knownSubtotal.total).toBe(360);
    expect(recovered.context.percent).toBe(20);
    expect(formatUsage(missing).join('\n')).toContain('输入 —');
    expect(formatUsage(recovered).join('\n')).toContain('累计 已知 360');
    const partial = tracker.record({ prompt_tokens: -1, completion_tokens: 2 } as CompletionUsage);
    expect(partial.single.input).toBeNull();
    expect(partial.single.total).toBeNull(); // Do not fabricate total from other fields.
    expect(partial.single.output).toBe(2);
  });

  it('preserves zero and reports percentages above capacity without clamping', () => {
    const tracker = new TokenUsageTracker(100);
    expect(tracker.record(usage(0, 0)).context.percent).toBe(0);
    expect(tracker.record(usage(150, 0)).context.percent).toBe(150);
  });

  it('keeps reported totals valid when optional detail fields are absent or invalid', () => {
    const tracker = new TokenUsageTracker(1000);
    const snapshot = tracker.record({
      prompt_tokens: 100, completion_tokens: 5, total_tokens: 105,
      prompt_tokens_details: { cached_tokens: -1, audio_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: NaN },
    });
    expect(snapshot.single).toEqual({ input: 100, output: 5, total: 105, cached: null, reasoning: null });
    expect(snapshot.cumulative.total).toBe(105);
    expect(snapshot.promptDetails).toEqual({ audio_tokens: 0 });
    expect(snapshot.completionDetails).toEqual({});
    expect(snapshot.context.percent).toBe(10);
    const next = tracker.record({ prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 });
    expect(next.cumulative.total).toBe(160);
    expect(next.single.cached).toBeNull();
    expect(snapshot.cumulative.total).toBe(105); // Earlier hook payloads remain stable.
    expect(snapshot.knownSubtotal.total).toBe(105);
  });
});

describe('agent mock API usage logging', () => {
  beforeEach(() => { vi.stubEnv('OPENAI_CONTEXT_WINDOW_TOKENS', '1000000'); });
  it('logs actual usage on every round, with independent nested subagent counters', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const childCreate = vi.fn(async () => response(usage(30, 5)));
    const create = vi.fn().mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'child', type: 'function', function: { name: 'example', arguments: '{}' } },
      ] } }], usage: usage(100, 50),
    }).mockResolvedValueOnce(response(usage(200, 20)));
    const result = await runAgent({ client: clientFor(create), model: 'test', input: 'task', systemPrompt: 'system', tools: [{
      schema: { type: 'function', function: { name: 'example' } },
      handler: async () => {
        await runAgent({ client: clientFor(childCreate), model: 'test', input: 'child', systemPrompt: 'child', tools: [], logPrefix: '[subagent:test]' });
        return 'child done';
      },
    }] });
    expect(result).toEqual({ finished: true, finalContent: 'done', rounds: 2 });
    const lines = log.mock.calls.map(args => args.join(' '));
    expect(lines.some(line => line.includes('[main] tokens') && line.includes('累计 370'))).toBe(true);
    expect(lines.some(line => line.includes('[subagent:test] tokens') && line.includes('累计 35'))).toBe(true);
    expect(lines.some(line => line.includes('[main]') && line.includes('上下文 0.02% (200 / 1M)'))).toBe(true);
    expect(lines.some(line => line.includes('缓存 10') && line.includes('推理 3'))).toBe(true);
    expect(lines.some(line => line.includes('prompt_tokens_details'))).toBe(false);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('continues normally when a compatible provider omits usage and resets each run', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const create = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response(usage(10, 5)));
    const options = { client: clientFor(create), model: 'test', input: 'task', systemPrompt: 'system', tools: [] };
    await expect(runAgent(options)).resolves.toMatchObject({ finished: true });
    await runAgent(options);
    const lines = log.mock.calls.map(args => args.join(' '));
    expect(lines.some(line => line.includes('上下文 — (— / 1M)'))).toBe(true);
    expect(lines.filter(line => line.includes('tokens #1'))).toHaveLength(2);
    expect(lines.some(line => line.includes('累计 15'))).toBe(true);
  });

  it('does not invent usage for failed requests', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const create = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    await expect(runAgent({ client: clientFor(create), model: 'test', input: 'task', systemPrompt: 'system', tools: [] }))
      .rejects.toThrow('provider unavailable');
    expect(log.mock.calls.some(args => args.join(' ').includes('tokens #'))).toBe(false);
  });
});
