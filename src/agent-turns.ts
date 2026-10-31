/** One gate for manual and scheduled turns sharing the same conversation. */
export class AgentTurns {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private readonly listeners = new Set<(busy: boolean) => void>();

  get busy(): boolean { return this.pending > 0; }
  get queued(): boolean { return this.pending > 1; }

  /** Observe every entry point, including a cron poll that finds no job. */
  onBusyChange(listener: (busy: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    // Reserve synchronously, before any await can admit a second turn.
    this.pending += 1;
    if (this.pending === 1) for (const listener of this.listeners) listener(true);
    const result = this.tail.then(task).finally(() => {
      this.pending -= 1;
      if (!this.busy) for (const listener of this.listeners) listener(false);
    });
    this.tail = result.catch(() => {});
    return result;
  }

  runIfIdle<T>(task: () => Promise<T>): Promise<T> | undefined {
    return this.busy ? undefined : this.run(task);
  }
}
