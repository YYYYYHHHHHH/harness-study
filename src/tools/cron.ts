import { parseCreateCronJob } from '../cron/types.js';
import type { ToolContext, ToolHandler } from './dispatch.js';

function scheduler(context: ToolContext) {
  if (!context.cron) throw new Error('cron 调度器未启动');
  return context.cron;
}

export const cronHandlers: Record<string, ToolHandler> = {
  create_cron_job: async (args, context) => {
    const job = await scheduler(context).create(parseCreateCronJob(args));
    return JSON.stringify({ ok: true, job });
  },
  cancel_cron_job: async (args, context) => {
    if (Object.keys(args).some(key => key !== 'id') || typeof args.id !== 'string' || !args.id.trim()) {
      throw new Error('cancel_cron_job 只接受非空字符串 id');
    }
    return JSON.stringify({ ok: true, cancelled: await scheduler(context).cancel(args.id) });
  },
  list_cron_job: async (args, context) => {
    if (Object.keys(args).length) throw new Error('list_cron_job 不接受参数');
    return JSON.stringify({ ok: true, jobs: await scheduler(context).list() });
  },
};
