import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CronEngine } from '../src/cron/engine.js';
import { CronScheduler } from '../src/cron/service.js';
import type { CreateCronJob } from '../src/cron/types.js';

const input: CreateCronJob = { prompt: '检查项目', drauble: true, recurring: false, cron: '* * * * * *' };
let directory: string;
let now: number;
let engines: CronEngine[];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'harness-cron-'));
  now = Date.parse('2026-10-28T00:00:00Z');
  engines = [];
});
afterEach(() => {
  engines.forEach(engine => engine.close());
  rmSync(directory, { recursive: true, force: true });
});
function open() {
  const engine = new CronEngine(directory, () => now);
  engines.push(engine);
  return engine;
}

describe('cron scheduling and persistence', () => {
  it('queues only when due and consumes one-shot tasks exactly once during normal operation', () => {
    const engine = open();
    const job = engine.create(input);
    engine.tick();
    expect(engine.take()).toBeUndefined();
    now += 1000;
    engine.tick();
    engine.tick();
    expect(engine.list()[0].status).toBe('queued');
    expect(engine.take()).toEqual(job);
    expect(engine.take()).toBeUndefined();
    expect(engine.list()[0].status).toBe('running');
    engine.finish(job.id);
    expect(engine.list()).toEqual([]);
    engine.close();
    expect(open().list()).toEqual([]);
  });

  it('coalesces missed recurring occurrences and schedules the next after completion', () => {
    const engine = open();
    const job = engine.create({ ...input, recurring: true });
    now += 60_000;
    engine.tick();
    now += 60_000;
    engine.tick();
    expect(engine.take()).toEqual(job);
    engine.tick();
    expect(engine.take()).toBeUndefined();
    engine.finish(job.id);
    engine.tick();
    expect(engine.take()).toBeUndefined();
    now += 1000;
    engine.tick();
    expect(engine.take()).toEqual(job);
  });

  it('restores durable scheduled and queued jobs but never ephemeral jobs', () => {
    const engine = open();
    const queued = engine.create(input);
    const future = engine.create({ ...input, cron: '0 * * * *' });
    engine.create({ ...input, drauble: false });
    now += 1000;
    engine.tick();
    engine.close();
    const restored = open();
    expect(restored.list().map(job => job.id)).toEqual([queued.id, future.id]);
    expect(restored.take()).toEqual(queued);
    expect(restored.take()).toBeUndefined();
  });

  it('recovers an unacknowledged in-flight job after restart', () => {
    const engine = open();
    const job = engine.create(input);
    now += 1000;
    engine.tick();
    engine.take();
    engine.close();
    expect(open().take()).toEqual(job);
  });

  it('enqueues a persisted overdue one-shot on startup tick', () => {
    const engine = open();
    const job = engine.create(input);
    engine.close();
    now += 86_400_000;
    const restored = open();
    restored.tick();
    expect(restored.take()).toEqual(job);
  });

  it('cancels scheduled, queued and running jobs without resurrecting them on finish', () => {
    const engine = open();
    const scheduled = engine.create(input);
    expect(engine.cancel(scheduled.id)).toBe(true);
    const queued = engine.create(input);
    const running = engine.create({ ...input, recurring: true });
    now += 1000;
    engine.tick();
    expect(engine.cancel(queued.id)).toBe(true);
    expect(engine.take()).toEqual(running);
    expect(engine.cancel(running.id)).toBe(true);
    engine.finish(running.id);
    expect(engine.cancel('missing')).toBe(false);
    expect(engine.take()).toBeUndefined();
    engine.close();
    expect(open().list()).toEqual([]);
  });

  it('does not write ephemeral job data to disk', () => {
    const engine = open();
    engine.create({ ...input, drauble: false });
    now += 1000;
    engine.tick();
    expect(readdirSync(directory)).toEqual(['.lock']);
  });

  it.each(['bad', '60 * * * * *', '0 0 31 2 *', '* * * *', '* * * * * * *'])(
    'rejects invalid cron %s without changing storage', cron => {
      const engine = open();
      expect(() => engine.create({ ...input, cron })).toThrow(/cron/);
      expect(engine.list()).toEqual([]);
    },
  );

  it('supports five-field minute expressions, steps and ranges', () => {
    const engine = open();
    engine.create({ ...input, cron: '*/5 * * * *' });
    engine.create({ ...input, cron: '10-20/5 * * * * *' });
    expect(engine.list().map(job => job.next_run_at)).toEqual([
      '2026-10-28T00:05:00.000Z', '2026-10-28T00:00:10.000Z',
    ]);
  });

  it('rejects corrupt files and releases its lock without overwriting data', () => {
    writeFileSync(join(directory, 'jobs.json'), '{bad');
    expect(open).toThrow(/加载/);
    expect(readFileSync(join(directory, 'jobs.json'), 'utf8')).toBe('{bad');
    expect(readdirSync(directory)).toEqual(['jobs.json']);
  });

  it('prevents two schedulers from owning the same directory', () => {
    const engine = open();
    expect(open).toThrow(/cron 锁/);
    engine.create(input);
    engine.close();
    expect(open().list()).toHaveLength(1);
  });

  it('leaves in-memory tasks unchanged and cleans temporary files on atomic-write failure', () => {
    const engine = open();
    const job = engine.create(input);
    // Replace destination with a directory so atomic rename fails.
    rmSync(join(directory, 'jobs.json'));
    const blocker = new CronEngine(join(directory, 'jobs.json'), () => now);
    try {
      expect(() => engine.cancel(job.id)).toThrow();
      expect(engine.list()).toHaveLength(1);
      expect(readdirSync(directory).filter(file => file.endsWith('.tmp'))).toEqual([]);
    } finally { blocker.close(); }
  });
});

it('runs a real worker, ticks every second, survives RPC validation errors, and shuts down cleanly', async () => {
  const scheduler = await CronScheduler.start(directory);
  try {
    await expect(scheduler.create({ ...input, cron: 'bad' })).rejects.toThrow(/cron/);
    const job = await scheduler.create(input);
    await new Promise(resolve => setTimeout(resolve, 1150));
    expect((await scheduler.list())[0].status).toBe('queued');
    expect(await scheduler.take()).toEqual(job);
    await scheduler.finish(job.id);
    expect(await scheduler.list()).toEqual([]);
    expect(await scheduler.cancel('missing')).toBe(false);
  } finally { await scheduler.stop(); }
  await scheduler.stop();
  const restored = await CronScheduler.start(directory);
  try { expect(await restored.list()).toEqual([]); }
  finally { await restored.stop(); }
  await expect(scheduler.list()).rejects.toThrow(/退出|关闭/);
});

it('reports startup errors without leaking a worker', async () => {
  writeFileSync(join(directory, 'jobs.json'), 'bad');
  await expect(CronScheduler.start(directory)).rejects.toThrow(/加载/);
  expect(readdirSync(directory)).toEqual(['jobs.json']);
});
