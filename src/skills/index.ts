import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

export interface Skill {
  name: string;
  description: string;
  body: string;
}

export type SkillRegistry = ReadonlyMap<string, Skill>;

function parseSkill(source: string): Skill {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(source);
  if (!match || match.index !== 0) throw new Error('必须以 YAML front matter（---）开头');
  const metadata: unknown = parse(match[1]);
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new Error('元信息必须是包含 name 和 description 的对象');
  }
  const { name, description } = metadata as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim()) throw new Error('name 必须是非空字符串');
  if (typeof description !== 'string' || !description.trim()) throw new Error('description 必须是非空字符串');
  return { name: name.trim(), description: description.trim(), body: source.slice(match[0].length) };
}

/** 每次 agent 启动时创建独立快照；工具加载时不再读取磁盘。 */
export async function scanSkills(root = process.cwd()): Promise<SkillRegistry> {
  const directory = resolve(root, 'skills');
  const skills = new Map<string, Skill>();
  async function visit(path: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) {
        await visit(file);
      } else if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
        try {
          const skill = parseSkill(await readFile(file, 'utf8'));
          if (skills.has(skill.name)) throw new Error(`skill name 重复：${skill.name}`);
          skills.set(skill.name, skill);
        } catch (error) {
          throw new Error(`加载 skill 失败（${file}）：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  try {
    await visit(directory);
  } catch (error) {
    // 只有根 skills 目录不存在才视为没有 skills；其他读取错误应显式报告。
    const fsError = error as NodeJS.ErrnoException;
    if (fsError.code !== 'ENOENT' || fsError.path !== directory) throw error;
  }
  return skills;
}

export function buildSkillsPrompt(skills: SkillRegistry): string {
  if (!skills.size) return '';
  const metadata = [...skills.values()].map(({ name, description }) => ({ name, description }));
  return `\n\n可用 skills：\n以下是可使用的 skill 名称和用途。任务匹配某个 skill 时，先调用 load_skill（name 为对应名称）加载完整正文，再按正文执行。\n${JSON.stringify(metadata, null, 2)}`;
}
