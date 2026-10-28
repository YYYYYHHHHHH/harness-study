/** One gate for manual and scheduled turns sharing the same conversation. */
export class AgentTurns {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  get busy(): boolean { return this.pending > 0; }

  run<T>(task: () => Promise<T>): Promise<T> {
    // Reserve synchronously, before any await can admit a second turn.
    this.pending += 1;
    const result = this.tail.then(task).finally(() => { this.pending -= 1; });
    this.tail = result.catch(() => {});
    return result;
  }

  runIfIdle<T>(task: () => Promise<T>): Promise<T> | undefined {
    return this.busy ? undefined : this.run(task);
  }
}
