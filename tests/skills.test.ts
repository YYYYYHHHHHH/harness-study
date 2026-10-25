import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as skillsModule from '../src/skills/index.js';

vi.mock('../src/hooks/logging.js', () => ({}));
vi.mock('../src/hooks/permission.js', () => ({}));
vi.mock('../src/hooks/summarize.js', () => ({}));
vi.mock('ora', () => ({ default: () => ({ start: () => ({ stop() {}, fail() {} }) }) }));
import { runAgent } from '../src/agent.js';
import { tools } from '../src/tools/index.js';
import { dispatchTool, type ToolContext } from '../src/tools/dispatch.js';

const { scanSkills, buildSkillsPrompt } = skillsModule;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'harness-skills-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function writeSkill(path: string, source: string) {
  const file = join(root, 'skills', path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, source, 'utf8');
  return file;
}

describe('skill discovery and metadata', () => {
  it('allows missing and empty skills directories', async () => {
    expect((await scanSkills(root)).size).toBe(0);
    await mkdir(join(root, 'skills'));
    expect(buildSkillsPrompt(await scanSkills(root))).toBe('');
  });

  it('scans nested skill.md files and parses quoted/multiline YAML without injecting bodies', async () => {
    await writeSkill('code_reivew/skill.md', '---\nname: "review"\ndescription: >-\n  检查代码：正确性\n  和测试覆盖\n---\n# 私有正文\n完整步骤\n');
    await writeSkill('nested/worker/SKILL.md', '\uFEFF---\r\nname: worker\r\ndescription: "执行任务"\r\n---\r\nworker body\r\n');
    await writeSkill('ignored.md', 'not a skill');
    const skills = await scanSkills(root);
    expect([...skills.keys()]).toEqual(['review', 'worker']);
    expect(skills.get('review')).toEqual({ name: 'review', description: '检查代码：正确性 和测试覆盖', body: '# 私有正文\n完整步骤\n' });
    expect(skills.get('worker')?.body).toBe('worker body\r\n');
    const prompt = buildSkillsPrompt(skills);
    expect(prompt).toContain('load_skill');
    expect(prompt).toContain('检查代码：正确性 和测试覆盖');
    expect(prompt).not.toContain('私有正文');
    expect(prompt).not.toContain('worker body');
    expect(prompt).not.toContain('code_reivew');
  });

  it.each([
    ['name: x', /front matter/],
    ['---\nname: x\n', /front matter/],
    ['prefix\n---\nname: x\n---\n', /front matter/],
    ['---\n- item\n---\n', /元信息必须/],
    ['---\nname: 42\ndescription: x\n---\n', /name 必须/],
    ['---\nname: " "\ndescription: x\n---\n', /name 必须/],
    ['---\nname: x\n---\n', /description 必须/],
    ['---\nname: x\ndescription: " "\n---\n', /description 必须/],
    ['---\nname: [\n---\n', /加载 skill 失败/],
  ])('reports invalid files with their path (%s)', async (source, error) => {
    const file = await writeSkill('bad/skill.md', source);
    await expect(scanSkills(root)).rejects.toThrow(error);
    await expect(scanSkills(root)).rejects.toThrow(file);
  });

  it('rejects duplicate names and non-directory skills roots', async () => {
    const source = '---\nname: same\ndescription: example\n---\nbody';
    await writeSkill('a/skill.md', source);
    const duplicate = await writeSkill('b/skill.md', source);
    await expect(scanSkills(root)).rejects.toThrow(`加载 skill 失败（${duplicate}）：skill name 重复：same`);
    await rm(join(root, 'skills'), { recursive: true });
    await writeFile(join(root, 'skills'), 'file');
    await expect(scanSkills(root)).rejects.toThrow(/ENOTDIR/);
  });

  it('loads the full cached body by metadata name even if the file changes or disappears', async () => {
    const body = '# Review\n' + '详细步骤\n'.repeat(10000);
    const file = await writeSkill('folder/skill.md', `---\nname: review\ndescription: code review\n---\n${body}`);
    const context: ToolContext = {
      client: {} as OpenAI, model: 'test', tools, skills: await scanSkills(root), logPrefix: '', runId: 'test',
    };
    await rm(file);
    expect(await dispatchTool('load_skill', '{"name":"review"}', context)).toBe(body);
    await expect(dispatchTool('load_skill', '{"name":"folder"}', context)).rejects.toThrow('未找到 skill');
    await expect(dispatchTool('load_skill', '{"name":"../folder/skill.md"}', context)).rejects.toThrow('未找到 skill');
  });
});

it('injects metadata at agent startup and returns the cached body through the model tool loop', async () => {
  const file = await writeSkill('review/skill.md', '---\nname: review\ndescription: 检查代码\n---\n秘密正文');
  const scan = vi.spyOn(skillsModule, 'scanSkills').mockImplementation(() => scanSkills(root));
  const create = vi.fn()
    .mockImplementationOnce(async (request) => {
      expect(request.messages[0].content).toContain('原始系统提示');
      expect(request.messages[0].content).toContain('检查代码');
      expect(request.messages[0].content).not.toContain('秘密正文');
      expect(request.tools.some((tool: any) => tool.function.name === 'load_skill')).toBe(true);
      await rm(file);
      return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'load-1', type: 'function', function: { name: 'load_skill', arguments: '{"name":"review"}' } },
      ] } }] };
    })
    .mockImplementationOnce(async (request) => {
      expect(request.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'load-1', content: '秘密正文' });
      return { choices: [{ message: { role: 'assistant', content: '完成' } }] };
    });
  const result = await runAgent({
    memory: false,
    client: { chat: { completions: { create } } } as unknown as OpenAI,
    model: 'test', input: 'review', systemPrompt: '原始系统提示', tools,
  });
  expect(result).toEqual({ finished: true, finalContent: '完成', rounds: 2 });
  expect(scan).toHaveBeenCalledTimes(1);
});

it('keeps catalogs isolated between runs and does not advertise skills when load_skill is disabled', async () => {
  await writeSkill('review/skill.md', '---\nname: review\ndescription: 检查代码\n---\nbody');
  const scan = vi.spyOn(skillsModule, 'scanSkills').mockImplementation(() => scanSkills(root));
  const create = vi.fn(async (request) => {
    expect(request.messages[0].content).toBe('base');
    return { choices: [{ message: { role: 'assistant', content: 'done' } }] };
  });
  const client = { chat: { completions: { create } } } as unknown as OpenAI;
  await runAgent({ memory: false, client, model: 'test', input: 'task', systemPrompt: 'base', tools: [] });
  await rm(join(root, 'skills'), { recursive: true });
  await runAgent({ memory: false, client, model: 'test', input: 'task', systemPrompt: 'base', tools });
  expect(scan).toHaveBeenCalledTimes(2);
});

it('reuses the CLI skill snapshot even if the catalog on disk changes while awaiting input', async () => {
  await writeSkill('review/skill.md', '---\nname: review\ndescription: CLI catalog\n---\nOriginal body');
  const skills = await scanSkills(root);
  await rm(join(root, 'skills'), { recursive: true });
  const scan = vi.spyOn(skillsModule, 'scanSkills');
  const create = vi.fn()
    .mockImplementationOnce(async request => {
      expect(request.messages[0].content).toContain('CLI catalog');
      return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'load-1', type: 'function', function: { name: 'load_skill', arguments: '{"name":"review"}' } },
      ] } }] };
    })
    .mockImplementationOnce(async request => {
      expect(request.messages.at(-1).content).toBe('Original body');
      return { choices: [{ message: { role: 'assistant', content: 'done' } }] };
    });
  await runAgent({
    memory: false,
    client: { chat: { completions: { create } } } as unknown as OpenAI,
    model: 'test', input: 'question', systemPrompt: 'base', tools, skills,
  });
  expect(scan).not.toHaveBeenCalled();
});
