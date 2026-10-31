import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentTurns } from '../src/agent-turns.js';
import { CronConsumer } from '../src/cron/consumer.js';
import type { CronJob, CronJobService } from '../src/cron/types.js';

const job: CronJob = { id: 'test', prompt: '定时输入', drauble: true, recurring: false, cron: '* * * * * *' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const scheduler: CronJobService = {
    create: vi.fn(), cancel: vi.fn(), list: vi.fn(),
    take: vi.fn().mockResolvedValueOnce(job).mockResolvedValue(undefined), finish: vi.fn().mockResolvedValue(undefined),
  };
  const turns = new AgentTurns();
  const execute = vi.fn().mockResolvedValue(undefined);
  const onError = vi.fn();
  const consumer = new CronConsumer(scheduler, turns, execute, onError);
  return { scheduler, turns, execute, onError, consumer };
}
afterEach(() => { vi.useRealTimers(); });

describe('shared agent turn gate and cron consumer', () => {
  it('keeps jobs queued while the agent is busy, then passes the original prompt to execution', async () => {
    const { scheduler, turns, execute, consumer } = fixture();
    const manual = deferred();
    const run = turns.run(() => manual.promise);
    consumer.tick();
    expect(scheduler.take).not.toHaveBeenCalled();
    manual.resolve();
    await run;
    consumer.tick();
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    await consumer.stop();
    expect(execute).toHaveBeenCalledExactlyOnceWith(job);
    expect(scheduler.finish).toHaveBeenCalledExactlyOnceWith(job.id);
    expect(turns.busy).toBe(false);
  });

  it('reserves before dequeue awaits, blocking another poll and serializing manual input', async () => {
    const { scheduler, turns, execute, consumer } = fixture();
    const dequeue = deferred();
    vi.mocked(scheduler.take).mockImplementationOnce(async () => { await dequeue.promise; return job; });
    consumer.tick();
    consumer.tick();
    const manual = vi.fn().mockResolvedValue(undefined);
    const run = turns.run(manual);
    await Promise.resolve();
    expect(manual).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    dequeue.resolve();
    await run;
    await consumer.stop();
    expect(scheduler.take).toHaveBeenCalledTimes(1);
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(manual.mock.invocationCallOrder[0]);
  });

  it('does not run two scheduled turns while a model call is pending', async () => {
    const { scheduler, execute, consumer } = fixture();
    const model = deferred();
    execute.mockReturnValue(model.promise);
    consumer.tick();
    await Promise.resolve();
    await Promise.resolve();
    consumer.tick();
    expect(scheduler.take).toHaveBeenCalledTimes(1);
    const stopped = consumer.stop();
    model.resolve();
    await stopped;
  });

  it('acknowledges agent errors and releases the gate for later user input', async () => {
    const { scheduler, turns, execute, onError, consumer } = fixture();
    execute.mockRejectedValue(new Error('model failed'));
    consumer.tick();
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    await consumer.stop();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'model failed' }));
    expect(scheduler.finish).toHaveBeenCalledWith(job.id);
    expect(turns.busy).toBe(false);
    await expect(turns.run(async () => 'user turn')).resolves.toBe('user turn');
  });

  it('polls every second, skips an empty queue, and stops polling on shutdown', async () => {
    vi.useFakeTimers();
    const { scheduler, execute, consumer } = fixture();
    consumer.start();
    consumer.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(scheduler.take).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1001);
    expect(scheduler.take).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    await consumer.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(scheduler.take).toHaveBeenCalledTimes(2);
  });

  it('halts polling on storage failure and leaves the pending job for recovery', async () => {
    vi.useFakeTimers();
    const { scheduler, turns, onError, consumer } = fixture();
    vi.mocked(scheduler.finish).mockRejectedValue(new Error('disk failed'));
    consumer.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(scheduler.take).toHaveBeenCalledTimes(1);
    expect(turns.busy).toBe(false);
    await consumer.stop();
  });

  it('releases the gate after a manual turn rejects and preserves queued order', async () => {
    const turns = new AgentTurns();
    const failed = turns.run(async () => { throw new Error('failed'); });
    const next = turns.run(async () => 'next');
    expect(turns.runIfIdle(async () => 'cron')).toBeUndefined();
    await expect(failed).rejects.toThrow('failed');
    await expect(next).resolves.toBe('next');
    expect(turns.busy).toBe(false);
  });
});


it.each(['before-take', 'during-take'])('does not launch cron work when shutdown occurs %s', async phase => {
  const { scheduler, execute, consumer } = fixture();
  const dequeue = deferred();
  vi.mocked(scheduler.take).mockImplementation(async () => { await dequeue.promise; return job; });
  consumer.tick();
  if (phase === 'during-take') await Promise.resolve();
  const stopped = consumer.stop();
  dequeue.resolve();
  await stopped;
  consumer.start();
  consumer.tick();
  expect(execute).not.toHaveBeenCalled();
  expect(scheduler.finish).not.toHaveBeenCalled();
  expect(scheduler.take).toHaveBeenCalledTimes(phase === 'during-take' ? 1 : 0);
});
