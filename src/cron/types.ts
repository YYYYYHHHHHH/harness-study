export interface CronJob {
  id: string;
  prompt: string;
  /** Public spelling retained for compatibility with the requested protocol. */
  drauble: boolean;
  recurring: boolean;
  cron: string;
}

export type CreateCronJob = Omit<CronJob, 'id'>;
export interface ListedCronJob extends CronJob {
  next_run_at: string;
  status: 'scheduled' | 'queued' | 'running';
}

export interface CronJobService {
  create(args: CreateCronJob): Promise<CronJob>;
  cancel(id: string): Promise<boolean>;
  list(): Promise<ListedCronJob[]>;
  take(): Promise<CronJob | undefined>;
  finish(id: string): Promise<void>;
}

export function parseCreateCronJob(args: Record<string, unknown>): CreateCronJob {
  for (const key of Object.keys(args)) {
    if (!['prompt', 'drauble', 'recurring', 'cron'].includes(key)) throw new Error(`未知 cron 参数：${key}`);
  }
  if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('prompt 必须是非空字符串');
  if (typeof args.cron !== 'string' || !args.cron.trim()) throw new Error('cron 必须是非空字符串');
  if (typeof args.drauble !== 'boolean') throw new Error('drauble 必须是 boolean');
  if (typeof args.recurring !== 'boolean') throw new Error('recurring 必须是 boolean（true 重复，false 一次性）');
  return { prompt: args.prompt, drauble: args.drauble, recurring: args.recurring, cron: args.cron.trim() };
}
