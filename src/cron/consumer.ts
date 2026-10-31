import type { AgentTurns } from '../agent-turns.js';
import type { CronJob, CronJobService } from './types.js';

export class CronConsumer {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopped = false;

  constructor(
    private scheduler: CronJobService,
    private turns: AgentTurns,
    private execute: (job: CronJob) => Promise<void>,
    private onError: (error: unknown) => void,
  ) {}

  start(): void {
    if (!this.stopped && !this.timer) this.timer = setInterval(() => { this.tick(); }, 1000);
  }

  tick(): void {
    if (this.stopped || this.active) return;
    const turn = this.turns.runIfIdle(async () => {
      if (this.stopped) return;
      const job = await this.scheduler.take();
      // A dequeued job remains pending on disk if shutdown overtakes the read.
      if (!job || this.stopped) return;
      try { await this.execute(job); }
      catch (error) { this.onError(error); }
      finally { await this.scheduler.finish(job.id); }
    });
    if (!turn) return;
    this.active = turn.catch(error => {
      // Storage/worker failures halt consumption; the saved pending job survives restart.
      this.stopped = true;
      clearInterval(this.timer);
      this.timer = undefined;
      this.onError(error);
    }).finally(() => { this.active = undefined; });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
}
