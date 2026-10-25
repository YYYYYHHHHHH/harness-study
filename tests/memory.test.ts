import type OpenAI from 'openai';
import type { ChatCompletionMessageParam as Message } from 'openai/resources/chat/completions';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { MemoryManager, MemoryStore, injectMemory, memoryMessage, type MemoryDraft } from '../src/memory/index.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'harness-memory-'));
  vi.stubEnv('OPENAI_CONTEXT_WINDOW_TOKENS', '100000');
  vi.stubEnv('OPENAI_MAX_OUTPUT_TOKENS', '1000');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const draft = (body = '用户偏好中文回答。', type: MemoryDraft['type'] = 'user'): MemoryDraft => ({
  name: '回答语言', description: '回答用户问题时使用中文；语言偏好。', type, body,
});
const answer = (value: unknown) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
function manager(create: ReturnType<typeof vi.fn>) {
  return new MemoryManager({ client: { chat: { completions: { create } } } as unknown as OpenAI,
    model: 'test', directory, countTokens: text => text.length });
}

it('persists YAML metadata, an indexed description, and full Markdown body across restarts', async () => {
  const store = new MemoryStore(directory);
  const item = { ...draft(), description: '偏好: 中文\n适用：所有回答', body: '## 语言\n\n用户偏好中文。\n\n---\n保留正文。' };
  await store.update(async () => [item]);
  const [loaded] = await new MemoryStore(directory).read();
  expect(loaded).toMatchObject(item);
  const index = await readFile(join(directory, 'MEMORY.md'), 'utf8');
  expect(index).toContain(loaded.filename);
  expect(index).toContain('description:');
  expect(index).not.toContain('保留正文');
  const file = await readFile(join(directory, loaded.filename), 'utf8');
  expect(file).toContain('type: user');
  expect(file).toContain(item.body);
});

it('atomically removes superseded indexed files and leaves unrelated files untouched', async () => {
  const store = new MemoryStore(directory);
  await store.update(async () => [draft('用户使用 pip。')]);
  const [old] = await store.read();
  await writeFile(join(directory, 'notes.md'), 'unmanaged notes');
  await store.update(async () => [draft('用户改用 uv。')]);
  expect((await store.read())[0].body).toBe('用户改用 uv。');
  expect(await readdir(directory)).not.toContain(old.filename);
  expect(await readFile(join(directory, 'notes.md'), 'utf8')).toBe('unmanaged notes');
});

it('serializes concurrent updates based on the latest committed memory', async () => {
  const first = new MemoryStore(directory);
  const second = new MemoryStore(directory);
  await Promise.all([
    first.update(async () => [draft('first')]),
    second.update(async existing => [...existing, draft('second')]),
  ]);
  expect((await first.read()).map(item => item.body)).toEqual(['first', 'second']);
});

it('keeps all committed files when validation or a writer lock fails', async () => {
  const store = new MemoryStore(directory);
  await store.update(async () => [draft()]);
  const before = await readFile(join(directory, 'MEMORY.md'), 'utf8');
  await expect(store.update(async () => Array.from({ length: 31 }, (_, index) => draft(String(index)))))
    .rejects.toThrow('最多 30');
  expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).toBe(before);
  await mkdir(join(directory, '.lock'));
  await expect(store.update(async () => [])).rejects.toThrow('正在更新');
  expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).toBe(before);
});

it('rejects a path escaping the memory directory', async () => {
  await writeFile(join(directory, 'MEMORY.md'), `---\n${stringify({ version: 1, memories: [{ filename: '../outside.md' }] })}---\n`);
  await expect(new MemoryStore(directory).read()).rejects.toThrow('路径无效');
});

it('does not call selection on an empty store and returns empty when the model selects nothing', async () => {
  const create = vi.fn().mockResolvedValue(answer([]));
  const memory = manager(create);
  expect(await memory.load_memory('你好')).toEqual([]);
  expect(create).not.toHaveBeenCalled();
  await memory.store.update(async () => [draft()]);
  expect(await memory.load_memory('无关问题')).toEqual([]);
  expect(create).toHaveBeenCalledTimes(1);
});

it('selects using only the last ten user inputs and catalog descriptions, then returns full bodies', async () => {
  const create = vi.fn();
  const memory = manager(create);
  await memory.store.update(async () => [draft('私有正文不进入选择请求')]);
  const [saved] = await memory.store.read();
  create.mockResolvedValue(answer([saved.filename, saved.filename]));
  let selected;
  for (let i = 0; i < 12; i++) selected = await memory.load_memory(`question-${i}`);
  const content = create.mock.calls.at(-1)![0].messages[1].content;
  expect(JSON.parse(content).recent_user_inputs).toEqual(Array.from({ length: 10 }, (_, i) => `question-${i + 2}`));
  expect(content).toContain(saved.description);
  expect(content).not.toContain(saved.body);
  expect(selected).toEqual([saved]);
  expect(create.mock.calls[0][0]).not.toHaveProperty('tools');
});

it('rejects unknown selected filenames instead of reading arbitrary paths', async () => {
  const memory = manager(vi.fn().mockResolvedValue(answer(['../../.env'])));
  await memory.store.update(async () => [draft()]);
  await expect(memory.load_memory('task')).rejects.toThrow('目录内');
});

it('extracts against existing memories, consolidates corrections and records both model usages', async () => {
  const corrected = draft('用户明确改用 uv，替代此前的 pip。', 'feedback');
  const create = vi.fn().mockResolvedValueOnce(answer([corrected])).mockResolvedValueOnce(answer([corrected]));
  const memory = manager(create);
  await memory.store.update(async () => [draft('用户使用 pip。')]);
  const onUsage = vi.fn();
  await memory.finishTurn([{ role: 'user', content: '以后改用 uv，不再用 pip。' }, { role: 'assistant', content: '好的。' }], onUsage);
  expect(create.mock.calls[0][0].messages[1].content).toContain('用户使用 pip');
  expect(create.mock.calls[0][0].messages[1].content).toContain('以后改用 uv');
  const consolidation = JSON.parse(create.mock.calls[1][0].messages[1].content);
  expect(consolidation.existing[0].body).toBe('用户使用 pip。');
  expect(consolidation.candidates).toEqual([corrected]);
  expect(await memory.store.read()).toMatchObject([corrected]);
  expect(onUsage).toHaveBeenCalledTimes(2);
});

it.each(['invalid-json', 'truncated', 'over-limit', 'network'])('preserves old memories when consolidation fails: %s', async mode => {
  const create = vi.fn().mockResolvedValueOnce(answer([draft('new')]));
  if (mode === 'invalid-json') create.mockResolvedValueOnce({ choices: [{ finish_reason: 'stop', message: { content: 'not json' } }] });
  if (mode === 'truncated') create.mockResolvedValueOnce({ choices: [{ finish_reason: 'length', message: { content: '[]' } }] });
  if (mode === 'over-limit') create.mockResolvedValueOnce(answer(Array.from({ length: 31 }, (_, i) => draft(String(i)))));
  if (mode === 'network') create.mockRejectedValueOnce(new Error('offline'));
  const memory = manager(create);
  await memory.store.update(async () => [draft('old')]);
  const before = await readFile(join(directory, 'MEMORY.md'), 'utf8');
  await expect(memory.finishTurn([{ role: 'user', content: 'remember new fact' }])).rejects.toThrow();
  expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).toBe(before);
  expect(await readdir(directory)).toHaveLength(2);
});

it('processes the entire oversized transcript in bounded chunks, including its final evidence', async () => {
  vi.stubEnv('OPENAI_CONTEXT_WINDOW_TOKENS', '30000');
  const create = vi.fn().mockResolvedValue(answer([]));
  const memory = manager(create);
  const transcript: Message[] = [{ role: 'user', content: '开始' }, { role: 'tool', tool_call_id: 'x', content: '🙂'.repeat(16000) + '末尾关键事实' }];
  await memory.finishTurn(transcript);
  expect(create.mock.calls.length).toBeGreaterThan(2);
  const chunks = create.mock.calls.map(([request]) => {
    expect(JSON.stringify(request.messages).length + 1000 + 20000 + 16).toBeLessThan(30000);
    return request.messages[1].content.split('本轮对话片段（JSONL）：\n')[1];
  });
  expect(chunks.join('')).toBe(transcript.map(item => JSON.stringify(item)).join('\n'));
});

it('inserts one request-only memory immediately after the anchor, even when its position moves', async () => {
  const store = new MemoryStore(directory);
  await store.update(async () => [draft()]);
  const loaded = memoryMessage(await store.read());
  const anchor: Message = { role: 'user', content: 'current task' };
  const messages: Message[] = [{ role: 'user', content: 'old' }, anchor, { role: 'assistant', content: 'working' }];
  const original = structuredClone(messages);
  const first = injectMemory(messages, anchor, loaded);
  expect(first[2]).toBe(loaded);
  expect(messages).toEqual(original);
  messages.shift();
  const next = injectMemory(messages, anchor, loaded);
  expect(next[1]).toBe(loaded);
  expect(next.filter(item => item === loaded)).toHaveLength(1);
  expect(messages).not.toContain(loaded);
  expect(() => injectMemory([], anchor, loaded)).toThrow('起点');
});
