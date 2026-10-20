import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { describe, expect, it, vi } from 'vitest';
import { scanSkills, type SkillRegistry } from '../src/skills/index.js';
import { completeSkillReference, expandSkillReferences, formatSkillList, readSkillInput, readSkillInputs } from '../src/cli/skill-slash.js';

const skills: SkillRegistry = new Map([
  ['code_review', { name: 'code_review', description: '检查代码', body: '# Review\n完整步骤\n' }],
  ['commit', { name: 'commit', description: '提交代码', body: 'Commit instructions' }],
]);

async function* lines(...values: string[]) {
  yield* values;
}

describe('CLI skill slash references', () => {
  it('expands a skill before the question, multiple references and repeated references', () => {
    expect(expandSkillReferences('/code_review 请检查 /commit 然后 /code_review', skills)).toEqual({
      input: '# Review\n完整步骤\n 请检查 Commit instructions 然后 # Review\n完整步骤\n', unknownSkills: [],
    });
    expect(expandSkillReferences('请检查 /code_review，谢谢', skills).input).toBe('请检查 # Review\n完整步骤\n，谢谢');
  });

  it('inserts the full discovered body without YAML metadata or recursive expansion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cli-slash-'));
    try {
      await mkdir(join(root, 'skills', 'different-folder'), { recursive: true });
      const body = '# Full body\n/commit\n' + '步骤\n'.repeat(5000);
      await writeFile(join(root, 'skills', 'different-folder', 'SKILL.md'),
        `---\nname: code_review\ndescription: review\n---\n${body}`);
      const result = expandSkillReferences('/code_review question', await scanSkills(root));
      expect(result.input).toBe(body + ' question');
      expect(result.unknownSkills).toEqual([]);
      expect(result.input).not.toContain('description:');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    '/code_review/file.ts', '/code_review.md', './code_review', '../code_review',
    'https://example.com/code_review', 'foo/code_review', '/tmp/code_review',
    'C:\\code_review', '`/code_review`', '普通文本/code_review', '/code_reviewExtra',
  ])('does not replace paths or embedded text: %s', input => {
    expect(expandSkillReferences(input, skills).input).toBe(input);
  });

  it('preserves unknown references and reports each unknown name once', () => {
    expect(expandSkillReferences('/missing 问题 /missing /commit', skills)).toEqual({
      input: '/missing 问题 /missing Commit instructions', unknownSkills: ['missing'],
    });
  });

  it('supports every catalog name literally, including namespaces, spaces and regex characters', () => {
    const catalog: SkillRegistry = new Map([
      ['review', { name: 'review', description: 'short', body: 'SHORT' }],
      ['review extra', { name: 'review extra', description: 'long', body: 'LONG' }],
      ['plugin:review.v2', { name: 'plugin:review.v2', description: 'namespaced', body: 'VERSIONED' }],
      ['review+(v3)', { name: 'review+(v3)', description: 'literal', body: 'LITERAL' }],
      ['代码审查', { name: '代码审查', description: '中文', body: 'CHINESE' }],
    ]);
    expect(expandSkillReferences('/review extra 然后 /plugin:review.v2 /review+(v3) /代码审查 /review', catalog))
      .toEqual({ input: 'LONG 然后 VERSIONED LITERAL CHINESE SHORT', unknownSkills: [] });
    expect(completeSkillReference('请使用 /review ex', catalog)).toEqual([['/review extra'], '/review ex']);
    expect(completeSkillReference('/plugin:review.', catalog)).toEqual([['/plugin:review.v2'], '/plugin:review.']);
    expect(completeSkillReference('/review+(', catalog)).toEqual([['/review+(v3)'], '/review+(']);
    expect(completeSkillReference('先 /review 然后 /代码', catalog)).toEqual([['/代码审查'], '/代码']);
  });

  it('lists names and descriptions, not bodies, and handles an empty registry', () => {
    expect(formatSkillList(skills)).toContain('/code_review — 检查代码');
    expect(formatSkillList(skills)).toContain('/commit — 提交代码');
    expect(formatSkillList(skills)).not.toContain('完整步骤');
    expect(formatSkillList(new Map())).toContain('未发现');
  });

  it('completes slash tokens at the start or after whitespace, but not paths', () => {
    expect(completeSkillReference('/', skills)).toEqual([['/code_review', '/commit'], '/']);
    expect(completeSkillReference('请检查 /', skills)).toEqual([['/code_review', '/commit'], '/']);
    expect(completeSkillReference('检查 /code', skills)).toEqual([['/code_review'], '/code']);
    expect(completeSkillReference('/missing', skills)).toEqual([[], '/missing']);
    for (const input of ['foo/code', '/tmp/co', 'https://co', '/commit 问题']) {
      expect(completeSkillReference(input, skills)).toEqual([[], '']);
    }
  });

  it('continues reading after list commands and reports unknown input without discarding it', async () => {
    const callbacks = { prompt: vi.fn(), list: vi.fn(), unknown: vi.fn() };
    expect(await readSkillInput(lines('/', ' / ', '/missing 请检查 /code_review'), skills, callbacks))
      .toBe('/missing 请检查 # Review\n完整步骤\n');
    expect(callbacks.prompt).toHaveBeenCalledTimes(3);
    expect(callbacks.list).toHaveBeenCalledTimes(2);
    expect(callbacks.unknown).toHaveBeenCalledWith(['missing']);
  });

  it('handles piped readline input without losing the line following a list', async () => {
    const rl = createInterface({ input: Readable.from(['/\n/code_review 问题\n']) });
    try {
      expect(await readSkillInput(rl, skills, { prompt() {}, list() {} })).toBe('# Review\n完整步骤\n 问题');
    } finally {
      rl.close();
    }
  });

  it('preserves the blank-line default but treats EOF after listing as cancellation', async () => {
    const callbacks = { prompt() {}, list() {} };
    expect(await readSkillInput(lines(''), skills, callbacks)).toBe('列出当前目录下的文件');
    expect(await readSkillInput(lines('/'), skills, callbacks)).toBeUndefined();
    expect(await readSkillInput(lines(), skills, callbacks)).toBeUndefined();
  });
});


it('keeps piped questions buffered across delayed agent turns and supports slash commands between turns', async () => {
  const rl = createInterface({ input: Readable.from(['第一问\n/\n/code_review 第二问\n第三问\n']) });
  const callbacks = { prompt: vi.fn(), list: vi.fn() };
  const received: string[] = [];
  try {
    for await (const input of readSkillInputs(rl, skills, callbacks)) {
      received.push(input);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(received).toEqual(['第一问', '# Review\n完整步骤\n 第二问', '第三问']);
    expect(callbacks.list).toHaveBeenCalledTimes(1);
  } finally {
    rl.close();
  }
});
