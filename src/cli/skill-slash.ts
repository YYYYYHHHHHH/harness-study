import type { SkillRegistry } from '../skills/index.js';

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Match catalog names literally (including namespaces, dots and spaces). Prefer
// longer names when one is a prefix of another, and leave ordinary paths intact.
function referencePattern(skills: SkillRegistry): RegExp {
  const names = [...skills.keys()].sort((a, b) => b.length - a.length).map(escapePattern);
  const alternatives = [...names, '[\\p{L}\\p{N}_-]+'].join('|');
  return new RegExp(`(^|\\s)\\/(${alternatives})(?=$|[\\s,，。!?！？;；:：)）\\]】])`, 'gu');
}

export interface ExpandedSkillInput {
  input: string;
  unknownSkills: string[];
}

/** One replacement pass leaves slash references inside skill bodies untouched. */
export function expandSkillReferences(input: string, skills: SkillRegistry): ExpandedSkillInput {
  const unknownSkills = new Set<string>();
  const expanded = input.replace(referencePattern(skills), (reference, prefix: string, name: string) => {
    const skill = skills.get(name);
    if (!skill) {
      unknownSkills.add(name);
      return reference;
    }
    return prefix + skill.body;
  });
  return { input: expanded, unknownSkills: [...unknownSkills] };
}

export function formatSkillList(skills: SkillRegistry): string {
  if (!skills.size) return '当前未发现可用 skill（在工作区 skills/ 下添加 SKILL.md）。';
  return '可用 skills（Tab 补全；输入 /名称 问题引用完整正文）：\n' +
    [...skills.values()].map(skill => `  /${skill.name} — ${skill.description}`).join('\n');
}

/** readline expects candidates and the exact trailing fragment to replace. */
export function completeSkillReference(line: string, skills: SkillRegistry): [string[], string] {
  const names = [...skills.keys()].map(name => `/${name}`);
  for (const match of line.matchAll(/(^|\s)\//gu)) {
    const fragment = line.slice(match.index + match[1].length);
    const candidates = names.filter(name => name.startsWith(fragment));
    if (candidates.length) return [candidates, fragment];
  }
  const match = /(?:^|\s)(\/[\p{L}\p{N}_-]*)$/u.exec(line);
  if (!match) return [[], ''];
  return [[], match[1]];
}

export interface SkillInputCallbacks {
  prompt(): void;
  list(text: string): void;
  unknown?(names: string[]): void;
}

/** Keep one input iterator alive across agent turns, including buffered piped lines. */
export async function* readSkillInputs(
  lines: AsyncIterable<string>,
  skills: SkillRegistry,
  callbacks: SkillInputCallbacks,
): AsyncGenerator<string> {
  callbacks.prompt();
  for await (const line of lines) {
    if (line.trim() === '/') {
      callbacks.list(formatSkillList(skills));
      callbacks.prompt();
      continue;
    }
    const result = expandSkillReferences(line.trim() || '列出当前目录下的文件', skills);
    if (result.unknownSkills.length) callbacks.unknown?.(result.unknownSkills);
    yield result.input;
    callbacks.prompt();
  }
}

/** Read a single question; EOF exits without a default task. */
export async function readSkillInput(
  lines: AsyncIterable<string>,
  skills: SkillRegistry,
  callbacks: SkillInputCallbacks,
): Promise<string | undefined> {
  for await (const input of readSkillInputs(lines, skills, callbacks)) return input;
  return undefined;
}
