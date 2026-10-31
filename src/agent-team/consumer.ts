import type { AgentResult } from '../agent.js';
import { AgentTurns } from '../agent-turns.js';
import { teamMessageToUserEvent, type TeamMessage } from './protocol.js';
import type { TeamAgentError, TeamAgentState, TeamMessageBus } from './types.js';

export interface TeamConsumerOptions {
  name: string;
  agentId: string;
  turns: AgentTurns;
  bus: TeamMessageBus & { fail(target: string, messageId: string, cause: unknown): Promise<void> };
  execute(input: string): Promise<AgentResult>;
  onState(state: TeamAgentState): void;
  onError(error: TeamAgentError): void;
}

/** One serial channel for initial/direct input, post-loop draining and idle polling.
 * Only this gate's owner may reserve a head; ack happens after a finished loop.
 */
export class TeamConsumer {
  private timer?: ReturnType<typeof setTimeout>;
  private readonly active = new Set<Promise<unknown>>();
  private stopped = false;
  private failed = false;
  private stopPromise?: Promise<void>;

  constructor(private readonly options: TeamConsumerOptions) {}

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private assertOpen(): void {
    if (this.stopped || this.failed) throw new Error(`agent 已停止接收轮次：${this.options.name}`);
  }

  /** Idempotent idle admission, also used after the last queued run releases its gate. */
  start(): void {
    if (this.stopped || this.failed || this.options.turns.busy || this.timer !== undefined) return;
    this.options.onState('idle');
    this.timer = setTimeout(() => this.tick(), 1000);
    this.timer.unref?.();
  }

  /** Clear even a stale tick's timer before checking busy. Never peek outside the gate. */
  tick(): void {
    this.clearTimer();
    if (this.stopped || this.failed) return;
    const task = this.options.turns.runIfIdle(() => this.consume());
    if (task) {
      this.options.onState('running');
      void this.track(task).catch(() => {});
    }
  }

  run(input: string): Promise<AgentResult> {
    this.assertOpen();
    this.clearTimer();
    const task = this.options.turns.run(async () => {
      this.assertOpen();
      return (await this.consume(input))!;
    });
    this.options.onState('running');
    return this.track(task);
  }

  private track<T>(task: Promise<T>): Promise<T> {
    const result = task.finally(() => {
      this.active.delete(result);
      // AgentTurns releases its reservation before this finally runs. Queued direct
      // turns keep it busy, so no timer exists between those turns either.
      if (this.stopped || this.failed) this.options.onState('stopped');
      else this.start();
    });
    this.active.add(result);
    return result;
  }

  private async execute(input: string): Promise<AgentResult> {
    const result = await this.options.execute(input);
    if (!result.finished) throw new Error(`agent ${this.options.name} 未完成任务（${result.rounds} 轮）`);
    return result;
  }

  private async consume(input?: string): Promise<AgentResult | undefined> {
    if (this.stopped || this.failed) return;
    let message: TeamMessage | undefined;
    let phase: TeamAgentError['phase'] = 'model';
    try {
      this.assertOpen();
      const result = input === undefined ? undefined : await this.execute(input);
      while (!this.stopped && !this.failed) {
        phase = 'storage';
        message = await this.options.bus.peek(this.options.name);
        if (!message || this.stopped || this.failed) break;
        phase = 'model';
        await this.execute(teamMessageToUserEvent(message).content as string);
        phase = 'storage';
        await this.options.bus.acknowledge(this.options.name, message.id);
        message = undefined;
      }
      return result;
    } catch (cause) {
      this.failed = true;
      this.clearTimer();
      const error: TeamAgentError = {
        phase, message: cause instanceof Error ? cause.message : String(cause),
        created_at: new Date().toISOString(),
        messageId: message?.id ?? (cause as { messageId?: string } | null)?.messageId,
      };
      if (message && phase === 'model') {
        try { await this.options.bus.fail(this.options.name, message.id, cause); }
        catch (failure) { error.message += `; 保存失败状态失败：${String(failure)}`; }
      }
      console.error(`[agent:${this.options.agentId}] message:${error.messageId ?? '<direct/unknown>'} ${phase}: ${error.message}`);
      this.options.onError(error);
      throw cause;
    }
  }

  /** Stop synchronously, then await owned work. Queued input and unread heads remain unrun. */
  stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopped = true;
      this.clearTimer();
      this.options.onState(this.options.turns.busy ? 'stopping' : 'stopped');
      this.stopPromise = Promise.allSettled([...this.active]).then(() => { this.options.onState('stopped'); });
    }
    return this.stopPromise;
  }
}
