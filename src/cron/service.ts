import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import type { CreateCronJob, CronJob, CronJobService, ListedCronJob } from './types.js';

/** RPC facade; only the dedicated worker owns schedules and the consumption queue. */
export class CronScheduler implements CronJobService {
  private worker: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private failure?: Error;
  private stopping?: Promise<void>;
  private ready: Promise<void>;
  private exited: Promise<void>;

  private constructor(directory: string) {
    this.worker = new Worker(new URL('./worker-bootstrap.mjs', import.meta.url), {
      workerData: { directory }, execArgv: [],
    });
    this.exited = new Promise(resolve => this.worker.once('exit', () => resolve()));
    this.ready = new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        this.failure = error;
        reject(error);
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
      };
      this.worker.on('error', fail);
      this.worker.on('exit', code => fail(new Error(`cron worker 已退出（${code}）`)));
      this.worker.on('message', message => {
        if (message.type === 'ready') { resolve(); return; }
        if (message.type === 'fatal') { fail(new Error(message.error)); return; }
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.result);
      });
    });
  }

  static async start(directory = resolve('.cron')): Promise<CronScheduler> {
    const scheduler = new CronScheduler(directory);
    try { await scheduler.ready; return scheduler; }
    catch (error) { await scheduler.worker.terminate(); throw error; }
  }

  private request<T>(command: string, args?: unknown): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.stopping && command !== 'stop') return Promise.reject(new Error('cron 调度器正在关闭'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, command, args }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  create(args: CreateCronJob): Promise<CronJob> { return this.request('create', args); }
  cancel(id: string): Promise<boolean> { return this.request('cancel', id); }
  list(): Promise<ListedCronJob[]> { return this.request('list'); }
  take(): Promise<CronJob | undefined> { return this.request('take'); }
  finish(id: string): Promise<void> { return this.request('finish', id); }

  stop(): Promise<void> {
    if (!this.stopping) {
      // A failed timer may leave a live worker. Ask it to release its lock too.
      this.failure = undefined;
      this.stopping = (async () => {
        if (this.worker.threadId === -1) return;
        try {
          await this.request('stop');
          await this.exited;
        } catch (error) {
          await this.worker.terminate();
          throw error;
        }
      })();
    }
    return this.stopping;
  }
}
