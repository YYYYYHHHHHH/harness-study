import type OpenAI from 'openai';
import type { ChatCompletionMessageParam as Message } from 'openai/resources/chat/completions';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextCompressor, createTokenCounter, isContextLengthError, L1_PLACEHOLDER, L2_MARKER } from '../src/context-compression.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'harness-context-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const response = (content = '用户目标：完成任务；已完成检查，下一步修改文件。') => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 123, completion_tokens: 20, total_tokens: 143 },
});
function fixture(overrides: Partial<ConstructorParameters<typeof ContextCompressor>[0]> = {}) {
  const create = vi.fn(async (_request: any) => response());
  const onUsage = vi.fn();
  const onEvent = vi.fn();
  const compressor = new ContextCompressor({
    client: { chat: { completions: { create } } } as unknown as OpenAI,
    model: 'test', runId: 'run', directory, contextWindow: 1_050_000, maxOutput: 128_000,
    countTokens: text => text.length, onUsage, onEvent, ...overrides,
  });
  return { compressor, create, onUsage, onEvent };
}
const user = (content: string): Message => ({ role: 'user', content });
const tool = (id: string, content: string): Message => ({ role: 'tool', tool_call_id: id, content });
const call = (...ids: string[]): Message => ({ role: 'assistant', content: null, tool_calls: ids.map(id => ({
  id, type: 'function', function: { name: 'read_file', arguments: '{}' },
})) });
const system: Message = { role: 'system', content: 'Keep all user constraints.' };

it('uses a real local tokenizer and treats special token strings as text', () => {
  const count = createTokenCounter('custom-provider-model');
  expect(count('hello world')).toBe(2);
  expect(count('中文🙂')).toBeGreaterThan(0);
  expect(count('<|endoftext|>')).toBeGreaterThan(0);
});

describe('L1 retention', () => {
  it('retains a token-weighted suffix, rounding up to whole tool results, not 20% of the count', () => {
    const { compressor } = fixture();
    const messages = [system, user('task'), call('a', 'b', 'c', 'd'),
      tool('a', 'a'.repeat(800)), tool('b', 'b'.repeat(100)), tool('c', 'c'.repeat(50)), tool('d', 'd'.repeat(50))];
    const original = structuredClone(messages);
    compressor.pruneOldTools(messages);
    expect(messages[3].content).toBe(L1_PLACEHOLDER);
    expect(messages.slice(4)).toEqual(original.slice(4)); // 100+50+50 = 20% of 1000
    expect(messages.slice(0, 3)).toEqual(original.slice(0, 3));
  });
  it('rounds a fractional boundary upward and keeps at least the newest tool', () => {
    const { compressor } = fixture();
    const messages = [tool('a', 'a'.repeat(70)), tool('b', 'b'.repeat(20)), tool('c', 'c'.repeat(10))];
    compressor.pruneOldTools(messages);
    expect(messages.map(message => message.content)).toEqual([L1_PLACEHOLDER, 'b'.repeat(20), 'c'.repeat(10)]);
    const single = [tool('only', 'one')];
    compressor.pruneOldTools(single);
    expect(single[0].content).toBe('one');
  });
  it('preserves L2 placeholders and existing L1 placeholders', () => {
    const { compressor } = fixture();
    const disk = tool('disk', L2_MARKER + '\nfile: /saved/result.txt');
    const old = tool('old', L1_PLACEHOLDER);
    const messages = [disk, old, tool('new', 'x'.repeat(1000))];
    compressor.pruneOldTools(messages);
    expect(messages[0]).toBe(disk);
    expect(messages[1]).toBe(old);
  });
});

describe('L2 offload', () => {
  it('offloads only >50000 tokens, preserves full text, counts and 1000 Unicode characters', async () => {
    const { compressor, create } = fixture();
    const content = '🙂'.repeat(1001) + 'test\n'.repeat(10000);
    const messages = [tool('../../unsafe', content), tool('boundary', 'b'.repeat(50000))];
    await compressor.offloadLargeTools(messages);
    const text = messages[0].content as string;
    expect(text).toContain(`${content.length}`);
    expect(text.endsWith('🙂'.repeat(1000))).toBe(true);
    const path = text.split('\n')[1].replace('调用结果已落盘：', '');
    expect(path.startsWith(join(directory, '.context/tool-results/run/'))).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(content);
    expect(messages[1].content).toHaveLength(50000);
    const snapshot = structuredClone(messages);
    await compressor.offloadLargeTools(messages);
    expect(messages).toEqual(snapshot);
    expect(await readdir(join(directory, '.context/tool-results/run'))).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
  });
  it('retains original results on storage failure', async () => {
    await writeFile(join(directory, '.context'), 'blocking file');
    const { compressor } = fixture();
    const messages = [tool('a', 'a'.repeat(50001))];
    const original = structuredClone(messages);
    await expect(compressor.offloadLargeTools(messages)).rejects.toThrow();
    expect(messages).toEqual(original);
  });
});

describe('thresholds and order', () => {
  it('does not compress at exactly 40%, then runs L2 before L1 above 40%', async () => {
    const { compressor, create } = fixture();
    const messages = [tool('a', 'a'.repeat(60000)), tool('b', 'b'.repeat(60000)), tool('new', 'c'.repeat(1000))];
    const base = compressor.contextTokens(messages);
    const padding = user('');
    messages.unshift(padding);
    padding.content = 'u'.repeat(420000 - base - compressor.messageTokens(padding));
    // Use a fresh object because the compressor treats messages as immutable.
    messages[0] = { ...padding };
    expect(compressor.contextTokens(messages)).toBe(420000);
    await compressor.prepare(messages);
    expect(messages[1].content).toHaveLength(60000);
    messages[0] = user((messages[0].content as string) + 'x');
    await compressor.prepare(messages);
    expect((messages[1].content as string).startsWith(L2_MARKER)).toBe(true);
    expect((messages[2].content as string).startsWith(L2_MARKER)).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });
  it('recalculates after free compression and avoids L3 when L2/L1 suffice', async () => {
    const { compressor, create } = fixture();
    const messages = [system, user('task'), call('huge'), tool('huge', 'x'.repeat(850000))];
    await compressor.prepare(messages);
    expect(create).not.toHaveBeenCalled();
    expect(compressor.contextTokens(messages)).toBeLessThan(420000);
  });
  it('triggers L3 only above 80%, preserving system and archiving each replaced message as JSONL', async () => {
    const { compressor, create, onUsage } = fixture();
    const messages = [system, user('')];
    messages[1] = user('x'.repeat(840000 - compressor.contextTokens(messages)));
    expect(compressor.contextTokens(messages)).toBe(840000);
    await compressor.prepare(messages);
    expect(create).not.toHaveBeenCalled();
    messages[1] = user((messages[1].content as string) + 'x');
    const originalHistory = structuredClone(messages.slice(1));
    await compressor.prepare(messages);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(system);
    expect(messages[1].content).toContain('[历史对话摘要]');
    expect(onUsage).toHaveBeenCalledWith(response().usage);
    const files = await readdir(join(directory, '.transcripts/run'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-\d{4}-\d{2}-\d{2}T.*Z\.jsonl$/);
    const history = (await readFile(join(directory, '.transcripts/run', files[0]), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(history).toEqual(originalHistory);
    expect(create.mock.calls[0][0]).not.toHaveProperty('tools');
  });
});

describe('overflow recovery', () => {
  it('rounds the formula budget down to a complete tool exchange and preserves the suffix', async () => {
    const { compressor } = fixture({ contextWindow: 30000, maxOutput: 1000 });
    const messages = [system, user('u'.repeat(1000)), call('a', 'b'), tool('a', 'x'.repeat(5000)), tool('b', 'y'.repeat(4000)), user('latest')];
    const tail = messages.slice(2);
    await compressor.recover(messages);
    expect(messages[0]).toBe(system);
    expect(messages[1].content).toContain('[历史对话摘要]');
    expect(messages.slice(2)).toEqual(tail); // Both tool responses stay with the assistant call.
    expect(messages[2]).toBe(tail[0]);
  });
  it('includes a complete multi-tool exchange when it fits the formula budget', async () => {
    const { compressor } = fixture({ contextWindow: 30000, maxOutput: 1000 });
    const messages = [system, user('task'), call('a', 'b'), tool('a', 'x'.repeat(2000)), tool('b', 'y'.repeat(2000)), user('z'.repeat(6000))];
    const last = messages.at(-1);
    await compressor.recover(messages);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toBe(last);
  });
  it('reports zero available complete messages and cannot loop indefinitely', async () => {
    const { compressor, create } = fixture({ contextWindow: 30000, maxOutput: 1000 });
    await expect(compressor.recover([system, user('x'.repeat(10000))])).rejects.toThrow('无法选取完整消息');
    expect(create).not.toHaveBeenCalled();
  });
  it('archives but does not replace history when summary does not shrink it', async () => {
    const { compressor, create } = fixture();
    create.mockResolvedValue(response('x'.repeat(1000)));
    const messages = [system, user('short')];
    const original = structuredClone(messages);
    await expect(compressor.recover(messages)).rejects.toThrow('未缩短');
    expect(messages).toEqual(original);
  });
  it.each(['', 'truncated', 'network'])('preserves history when summary fails: %s', async mode => {
    const { compressor, create } = fixture();
    if (mode === 'network') create.mockRejectedValue(new Error('provider unavailable'));
    else create.mockResolvedValue({ ...response(mode), choices: [{ ...response(mode).choices[0], finish_reason: mode ? 'length' : 'stop' }] });
    const messages = [system, user('x'.repeat(2000))];
    const original = structuredClone(messages);
    await expect(compressor.recover(messages)).rejects.toThrow();
    expect(messages).toEqual(original);
  });
  it('chunks oversized L3 input and merges summaries without losing any transcript text', async () => {
    const { compressor, create } = fixture({ contextWindow: 30000, maxOutput: 1000 });
    const messages = [system, user('x'.repeat(35000) + '最新约束')];
    const transcript = JSON.stringify(messages[1]) + '\n';
    await compressor.prepare(messages);
    expect(create.mock.calls.length).toBeGreaterThan(1);
    const chunks = create.mock.calls.map(([request]) => {
      expect(JSON.stringify(request.messages).length + 1000 + 20000).toBeLessThan(30000);
      const content = request.messages.at(-1).content as string;
      return content.split('历史片段：\n')[1];
    });
    expect(chunks.join('')).toBe(transcript);
    expect(create.mock.calls[1][0].messages.at(-1).content).toContain('先前摘要');
  });
  it('halves summary input on context errors and terminates repeated failures', async () => {
    const { compressor, create } = fixture({ contextWindow: 30000, maxOutput: 1000 });
    create.mockRejectedValueOnce({ code: 'context_length_exceeded' });
    await compressor.recover([system, user('x'.repeat(7000))]);
    expect(create.mock.calls.length).toBeGreaterThan(2);
    expect(create.mock.calls[1][0].messages.at(-1).content.length).toBeLessThan(create.mock.calls[0][0].messages.at(-1).content.length);
    create.mockRejectedValue({ code: 'context_length_exceeded' });
    await expect(compressor.recover([system, user('x'.repeat(7000))])).rejects.toMatchObject({ code: 'context_length_exceeded' });
    expect(create.mock.calls.length).toBeLessThan(30);
  });
});

it('only classifies actual context errors, not auth, rate limits or arbitrary 400s', () => {
  for (const error of [{ code: 'context_length_exceeded' }, { error: { code: 'prompt_too_long' } }, new Error('maximum context length is 100 tokens'), new Error('prompt is too long')]) {
    expect(isContextLengthError(error)).toBe(true);
  }
  for (const error of [null, new Error('rate limit'), { status: 400, message: 'invalid tool messages' }, { status: 401 }]) {
    expect(isContextLengthError(error)).toBe(false);
  }
});
