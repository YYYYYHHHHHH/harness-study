import { mkdir, readdir, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ToolHandler } from './dispatch.js';

export type TaskStatus = 'wait' | 'procing' | 'compleate';
export interface Task {
  taskid: string;
  description: string;
  status: TaskStatus;
  depends: string[];
  owner: string | null;
}
const statuses: readonly string[] = ['wait', 'procing', 'compleate'];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('任务参数必须是对象');
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 必须是非空字符串`);
  return value;
}
function ids(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${name} 必须是非空 task_id 数组`);
  const result = value.map(v => text(v, name));
  if (new Set(result).size !== result.length) throw new Error(`${name} 包含重复 ID`);
  return result;
}
function parseTask(value: unknown, stored = false): Task {
  const row = object(value);
  const allowed = ['taskid', 'description', 'status', 'depends', ...(stored ? ['owner'] : [])];
  if (Object.keys(row).some(k => !allowed.includes(k))) throw new Error('任务包含未知字段');
  const taskid = text(row.taskid, 'taskid');
  const description = text(row.description, 'description');
  if (typeof row.status !== 'string' || !statuses.includes(row.status)) throw new Error('status 必须是 wait/procing/compleate');
  if (!Array.isArray(row.depends)) throw new Error('depends 必须是 ID 数组');
  const depends = row.depends.length ? ids(row.depends, 'depends') : [];
  if (stored && row.owner !== null && (typeof row.owner !== 'string' || !row.owner.trim())) throw new Error('owner 无效');
  return { taskid, description, status: row.status as TaskStatus, depends, owner: stored ? row.owner as string | null : null };
}
function validateGraph(tasks: Task[]): void {
  const byId = new Map(tasks.map(task => [task.taskid, task]));
  if (byId.size !== tasks.length) throw new Error('taskid 已存在或重复');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error(`循环依赖：${id}`);
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new Error(`依赖任务不存在：${id}`);
    visiting.add(id);
    for (const dep of task.depends) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of tasks) visit(task.taskid);
}

/** All readers and writers use the same cross-process lock. No stale-lock stealing:
 * a slow live process must never lose its lock to a second claimant. */
export class TaskStore {
  readonly directory: string;
  constructor(workdir = process.cwd()) { this.directory = resolve(workdir, '.task'); }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    if ((await lstat(this.directory)).isSymbolicLink()) throw new Error('.task 不能是符号链接');
    const lock = join(this.directory, '.lock');
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await mkdir(lock); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error('任务存储被锁定；如上次进程崩溃，请确认没有任务写入进程后手动移除 .task/.lock');
        await delay(20);
      }
    }
    try { return await operation(); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }
  private async load(): Promise<{ task: Task; file: string }[]> {
    const rows: { task: Task; file: string }[] = [];
    for (const name of (await readdir(this.directory)).sort()) {
      if (!name.endsWith('.json')) continue;
      const file = join(this.directory, name);
      if (!(await lstat(file)).isFile()) throw new Error(`任务文件不是普通文件：${name}`);
      try { rows.push({ task: parseTask(JSON.parse(await readFile(file, 'utf8')), true), file }); }
      catch (error) { throw new Error(`任务文件损坏：${name}`, { cause: error }); }
    }
    validateGraph(rows.map(row => row.task));
    return rows;
  }
  private async save(file: string, task: Task): Promise<void> {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(task, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temp, file);
    } finally { await rm(temp, { force: true }); }
  }
  async create(value: unknown): Promise<Task[]> {
    if (!Array.isArray(value) || !value.length) throw new Error('tasks 必须是非空数组');
    const tasks = value.map(task => parseTask(task));
    return this.locked(async () => {
      const existing = await this.load();
      validateGraph([...existing.map(row => row.task), ...tasks]);
      for (const task of tasks) await this.save(join(this.directory, `${Date.now()}-${randomUUID()}.json`), task);
      return tasks;
    });
  }
  async get(value?: unknown): Promise<Task[]> {
    const requested = value === undefined ? undefined : (Array.isArray(value) && !value.length ? [] : ids(value, 'task_id'));
    return this.locked(async () => {
      const rows = await this.load();
      return requested === undefined ? rows.map(row => row.task) : this.select(rows, requested).map(row => row.task);
    });
  }
  private select(rows: { task: Task; file: string }[], requested: string[]) {
    return requested.map(id => {
      const row = rows.find(row => row.task.taskid === id);
      if (!row) throw new Error(`任务不存在：${id}`);
      return row;
    });
  }
  async claim(value: unknown, agentOwner: string): Promise<Task> {
    const id = text(value, 'task_id');
    const owner = text(agentOwner, 'agent owner');
    return this.locked(async () => {
      const rows = await this.load();
      const row = this.select(rows, [id])[0]!;
      if (row.task.owner !== null) throw new Error(`任务已有 owner：${id}`);
      if (row.task.status !== 'wait') throw new Error(`任务不是 wait：${id}`);
      const blocked = row.task.depends.filter(dep => rows.find(r => r.task.taskid === dep)!.task.status !== 'compleate');
      if (blocked.length) throw new Error(`前置依赖未完成：${blocked.join(', ')}`);
      const task: Task = { ...row.task, status: 'procing', owner };
      await this.save(row.file, task);
      return task;
    });
  }
  async complete(value: unknown): Promise<Task[]> {
    const requested = ids(value, 'task_id');
    return this.locked(async () => {
      // Validate every ID before any write; already-completed tasks are idempotent.
      const rows = this.select(await this.load(), requested);
      const tasks = rows.map(row => ({ ...row.task, status: 'compleate' as const }));
      for (let i = 0; i < rows.length; i++) await this.save(rows[i]!.file, tasks[i]!);
      return tasks;
    });
  }
}

export const taskHandlers: Record<string, ToolHandler> = {
  create_tasks: async args => JSON.stringify({ ok: true, tasks: await new TaskStore().create(args.tasks) }),
  clamic_task: async (args, context) => JSON.stringify({ ok: true, task: await new TaskStore().claim(args.task_id, context.agentId ?? context.runId) }),
  get_tasks_detail: async args => JSON.stringify({ ok: true, tasks: await new TaskStore().get(args.task_id) }),
  complate_tasks: async args => JSON.stringify({ ok: true, tasks: await new TaskStore().complete(args.task_id) }),
};
