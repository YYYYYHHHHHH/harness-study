import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, rmdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';

export const MEMORY_LIMIT = 30;
export const MEMORY_TYPES = ['user', 'project', 'feedback', 'refence'] as const;
export type MemoryType = typeof MEMORY_TYPES[number];
export interface MemoryDraft {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}
export interface MemoryEntry extends MemoryDraft {
  filename: string;
  updated_at: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('记忆必须是对象');
  return value as Record<string, unknown>;
}

function field(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`记忆 ${name} 必须是 1–${max} 字符的字符串`);
  }
  return value.trim();
}

export function validateDraft(value: unknown): MemoryDraft {
  const item = object(value);
  // Accept the conventional spelling, while keeping the user's on-disk type vocabulary.
  const type = item.type === 'reference' ? 'refence' : item.type;
  if (!MEMORY_TYPES.includes(type as MemoryType)) throw new Error('未知的记忆类型');
  return {
    name: field(item.name, 'name', 200),
    description: field(item.description, 'description', 600),
    type: type as MemoryType,
    body: field(item.body, 'body', 8000),
  };
}

export function validateMemories(value: unknown): MemoryDraft[] {
  if (!Array.isArray(value) || value.length > MEMORY_LIMIT) throw new Error('记忆结果必须是最多 30 项的数组');
  const result = value.map(validateDraft);
  const keys = new Set<string>();
  return result.filter(item => {
    const key = JSON.stringify([item.type, item.body]);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

function frontMatter(text: string): { metadata: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error('记忆文件缺少 YAML 元信息');
  return { metadata: object(parse(match[1])), body: text.slice(match[0].length).trim() };
}

const queues = new Map<string, Promise<unknown>>();

/** MEMORY.md is the commit point: readers only see a fully written generation. */
export class MemoryStore {
  readonly directory: string;
  constructor(directory = resolve(process.cwd(), '.memory')) { this.directory = resolve(directory); }

  async read(): Promise<MemoryEntry[]> {
    const indexPath = join(this.directory, 'MEMORY.md');
    let source: string;
    try { source = await this.readRegularFile(indexPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const { metadata } = frontMatter(source);
    if (metadata.version !== 1 || !Array.isArray(metadata.memories)) throw new Error('MEMORY.md 索引格式无效');
    const seen = new Set<string>();
    return Promise.all(metadata.memories.map(async value => {
      const item = object(value);
      const filename = field(item.filename, 'filename', 200);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(filename) || filename === 'MEMORY.md' || seen.has(filename)) {
        throw new Error('记忆索引路径无效或重复');
      }
      seen.add(filename);
      const file = frontMatter(await this.readRegularFile(join(this.directory, filename)));
      const draft = validateDraft({ ...file.metadata, body: file.body });
      for (const key of ['name', 'description', 'type'] as const) {
        if (item[key] !== draft[key]) throw new Error(`记忆索引与文件不一致：${filename} (${key})`);
      }
      const updated_at = field(file.metadata.updated_at, 'updated_at', 100);
      return { ...draft, filename, updated_at };
    }));
  }

  private async readRegularFile(path: string): Promise<string> {
    if (!(await lstat(path)).isFile()) throw new Error(`记忆路径必须是普通文件：${path}`);
    return readFile(path, 'utf8');
  }

  /** Serialize read → model decisions → publish, including other managers in this process. */
  async update(transform: (existing: MemoryEntry[]) => Promise<MemoryDraft[]>): Promise<void> {
    const previous = queues.get(this.directory) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const lock = join(this.directory, '.lock');
      // A second CLI process must not overwrite a decision based on stale memory.
      try { await mkdir(lock); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('记忆目录正在更新（.memory/.lock 已存在）');
        throw error;
      }
      try {
        const existing = await this.read();
        const next = validateMemories(await transform(existing));
        await this.publish(existing, next);
      } finally { await rmdir(lock); }
    });
    queues.set(this.directory, pending);
    try { await pending; }
    finally { if (queues.get(this.directory) === pending) queues.delete(this.directory); }
  }

  private async publish(previous: MemoryEntry[], drafts: MemoryDraft[]): Promise<void> {
    const created: string[] = [];
    const temporaryIndex = join(this.directory, `.index-${randomUUID()}.tmp`);
    const next: MemoryEntry[] = [];
    try {
      for (const draft of drafts) {
        const unchanged = previous.find(item => (['name', 'description', 'type', 'body'] as const)
          .every(key => item[key] === draft[key]));
        if (unchanged) { next.push(unchanged); continue; }
        const filename = `memory-${randomUUID()}.md`;
        const updated_at = new Date().toISOString();
        const { body, ...metadata } = draft;
        const path = join(this.directory, filename);
        created.push(path);
        await writeFile(path, `---\n${stringify({ ...metadata, updated_at })}---\n\n${body}\n`, { flag: 'wx', mode: 0o600 });
        next.push({ ...draft, filename, updated_at });
      }
      const memories = next.map(({ body: _body, ...metadata }) => metadata);
      await writeFile(temporaryIndex, `---\n${stringify({ version: 1, memories })}---\n\n# Memory index\n\nfilename 是记忆文件的相对索引；description 用于模型选择相关记忆。\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporaryIndex, join(this.directory, 'MEMORY.md'));
    } catch (error) {
      await Promise.all([...created, temporaryIndex].map(path => unlink(path).catch(() => {})));
      throw error;
    }
    // Cleanup follows the atomic index switch; never delete unindexed/user-owned files.
    const retained = new Set(next.map(item => item.filename));
    await Promise.all(previous.filter(item => !retained.has(item.filename))
      .map(item => unlink(join(this.directory, item.filename)).catch(() => {})));
  }
}
