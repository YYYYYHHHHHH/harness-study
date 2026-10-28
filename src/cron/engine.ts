import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { parseCreateCronJob, type CreateCronJob, type CronJob, type ListedCronJob } from './types.js';

interface Entry { job: CronJob; nextRun: number; pending: boolean }

function nextRun(cron: string, now: number): number {
  if (![5, 6].includes(cron.split(/\s+/).length)) throw new Error('cron 必须是五字段或六字段表达式（六字段首位为秒）');
  try { return CronExpressionParser.parse(cron, { currentDate: new Date(now) }).next().getTime(); }
  catch (error) { throw new Error(`无效 cron 表达式：${cron}`, { cause: error }); }
}

/** Owned by one worker. Synchronous mutations make persistence and queue updates atomic to RPCs. */
export class CronEngine {
  private cron_jobs = new Map<string, Entry>();
  private consumptionQueue: string[] = [];
  private running = new Set<string>();
  private saved = JSON.stringify({ version: 1, jobs: [] });
  private closed = false;

  constructor(private directory: string, private now: () => number = Date.now) {
    mkdirSync(directory, { recursive: true });
    try { mkdirSync(join(directory, '.lock')); }
    catch (error) { throw new Error(`无法取得 cron 锁：${join(directory, '.lock')}（同一工作区只允许一个调度器）`, { cause: error }); }
    try {
      let raw: string;
      try { raw = readFileSync(join(directory, 'jobs.json'), 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      const data = JSON.parse(raw);
      if (data?.version !== 1 || !Array.isArray(data.jobs)) throw new Error('无效 cron 存储格式');
      for (const entry of data.jobs) {
        if (!entry?.job || typeof entry.job.id !== 'string' || !entry.job.id.trim()
          || !Number.isFinite(entry.nextRun) || !Number.isFinite(new Date(entry.nextRun).getTime())
          || typeof entry.pending !== 'boolean') throw new Error('无效 cron 任务记录');
        const { id, ...input } = entry.job;
        const job = { id, ...parseCreateCronJob(input) };
        nextRun(job.cron, this.now());
        if (!job.drauble || this.cron_jobs.has(id)) throw new Error('cron 持久化标记或任务 ID 无效');
        this.cron_jobs.set(id, { job, nextRun: entry.nextRun, pending: entry.pending });
        if (entry.pending) this.consumptionQueue.push(id);
      }
      this.saved = this.serialize(this.cron_jobs);
    } catch (error) {
      this.close();
      throw new Error(`加载 ${join(directory, 'jobs.json')} 失败`, { cause: error });
    }
  }

  private serialize(entries: Map<string, Entry>): string {
    return JSON.stringify({ version: 1, jobs: [...entries.values()].filter(entry => entry.job.drauble) });
  }

  private commit(entries: Map<string, Entry>): void {
    if (this.closed) throw new Error('cron 调度器已关闭');
    const data = this.serialize(entries);
    if (data !== this.saved) {
      const temporary = join(this.directory, `${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, data + '\n', { mode: 0o600, flag: 'wx' });
        renameSync(temporary, join(this.directory, 'jobs.json'));
      } finally { rmSync(temporary, { force: true }); }
      this.saved = data;
    }
    this.cron_jobs = entries;
  }

  create(input: CreateCronJob): CronJob {
    const args = parseCreateCronJob(input as unknown as Record<string, unknown>);
    const job = { id: randomUUID(), ...args };
    const entry = { job, nextRun: nextRun(job.cron, this.now()), pending: false };
    this.commit(new Map(this.cron_jobs).set(job.id, entry));
    return { ...job };
  }

  cancel(id: string): boolean {
    if (!this.cron_jobs.has(id)) return false;
    const entries = new Map(this.cron_jobs);
    entries.delete(id);
    this.commit(entries);
    this.consumptionQueue = this.consumptionQueue.filter(queued => queued !== id);
    this.running.delete(id);
    return true;
  }

  list(): ListedCronJob[] {
    return [...this.cron_jobs.values()].map(({ job, nextRun, pending }) => ({
      ...job, next_run_at: new Date(nextRun).toISOString(),
      status: this.running.has(job.id) ? 'running' : pending ? 'queued' : 'scheduled',
    }));
  }

  tick(): void {
    const now = this.now();
    const entries = new Map(this.cron_jobs);
    const due: string[] = [];
    for (const [id, entry] of entries) {
      if (entry.pending || entry.nextRun > now) continue;
      entries.set(id, { ...entry, pending: true });
      due.push(id);
    }
    if (!due.length) return;
    this.commit(entries);
    this.consumptionQueue.push(...due);
  }

  take(): CronJob | undefined {
    const id = this.consumptionQueue.shift();
    if (!id) return undefined;
    this.running.add(id);
    return { ...this.cron_jobs.get(id)!.job };
  }

  finish(id: string): void {
    const entry = this.cron_jobs.get(id);
    if (!entry || !this.running.has(id)) return;
    const entries = new Map(this.cron_jobs);
    if (entry.job.recurring) entries.set(id, { ...entry, pending: false, nextRun: nextRun(entry.job.cron, this.now()) });
    else entries.delete(id);
    this.commit(entries);
    this.running.delete(id);
  }

  close(): void {
    if (this.closed) return;
    rmSync(join(this.directory, '.lock'), { recursive: true, force: true });
    this.closed = true;
  }
}
