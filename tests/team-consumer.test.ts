import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentTurns } from '../src/agent-turns.js';
import { CronConsumer } from '../src/cron/consumer.js';
import { TeamConsumer, type TeamConsumerOptions } from '../src/agent-team/consumer.js';
import type { TeamMessage } from '../src/agent-team/protocol.js';
import type { AgentResult } from '../src/agent.js';

const done: AgentResult = { finished: true, finalContent: 'ok', rounds: 1 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const consumers: TeamConsumer[] = [];
function setup(name = 'worker', options: Pick<TeamConsumerOptions, 'maxMessagesPerTurn' | 'haltOnDirectError'> = {}) {
  const queue: TeamMessage[] = [];
  let reserved: string | undefined;
  const turns = new AgentTurns();
  const bus = {
    append: vi.fn(),
    peek: vi.fn(async () => {
      expect(turns.busy).toBe(true);
      expect(reserved).toBeUndefined();
      reserved = queue[0]?.id;
      return queue[0];
    }),
    acknowledge: vi.fn(async (_name: string, id: string) => {
      expect(id).toBe(reserved);
      expect(queue.shift()?.id).toBe(id);
      reserved = undefined;
    }),
    fail: vi.fn(async () => {}),
  };
  const execute = vi.fn(async (_input: string) => done);
  const onState = vi.fn();
  const onError = vi.fn();
  const consumer = new TeamConsumer({ ...options, name, agentId: `agent:${name}`, turns, bus, execute, onState, onError });
  consumers.push(consumer);
  let nextId = 0;
  const send = (content: string) => {
    const message = { id: `${name}-${++nextId}`, sender: 'main', target: name, content, created_at: new Date().toISOString() };
    queue.push(message);
    return message;
  };
  return { consumer, turns, bus, execute, onState, onError, send, queue };
}
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(async () => {
  await Promise.all(consumers.splice(0).map(c => c.stop()));
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(['main', 'worker'])('wakes %s at 1000ms, with one idle timer and no timer during a loop', async name => {
  const t = setup(name);
  const finish = deferred<AgentResult>();
  t.execute.mockReturnValue(finish.promise);
  t.consumer.start();
  t.consumer.start();
  expect(vi.getTimerCount()).toBe(1);
  const message = t.send('hello');
  await vi.advanceTimersByTimeAsync(999);
  expect(t.bus.peek).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(t.execute).toHaveBeenCalledWith(JSON.stringify({ type: 'team_message', message }));
  expect(vi.getTimerCount()).toBe(0);
  finish.resolve(done);
  await vi.advanceTimersByTimeAsync(0);
  expect(t.queue).toEqual([]);
  expect(vi.getTimerCount()).toBe(1);
});

it('drains after initial/direct input, including messages arriving during a loop, in FIFO order', async () => {
  const t = setup();
  const finish = deferred<AgentResult>();
  t.execute.mockReturnValueOnce(finish.promise);
  const run = t.consumer.run('initial');
  const first = t.send('first');
  await Promise.resolve();
  const second = t.send('second');
  t.execute.mockImplementation(async input => {
    expect(vi.getTimerCount()).toBe(0);
    if (JSON.parse(input).message.id === first.id) t.send('during drain');
    return done;
  });
  finish.resolve(done);
  await expect(run).resolves.toBe(done);
  expect(t.execute.mock.calls.map(([input]) => input === 'initial' ? input : JSON.parse(input).message.content))
    .toEqual(['initial', 'first', 'second', 'during drain']);
  expect(t.bus.acknowledge.mock.calls.slice(0, 2)).toEqual([['worker', first.id], ['worker', second.id]]);
  expect(vi.getTimerCount()).toBe(1);
});

it.each(['tick-first', 'direct-first'])('serializes tick/direct collision (%s) without losing a head', async order => {
  const t = setup();
  let active = 0;
  let maximum = 0;
  const finish = deferred<AgentResult>();
  t.execute.mockImplementation(async () => {
    maximum = Math.max(maximum, ++active);
    expect(vi.getTimerCount()).toBe(0);
    await finish.promise;
    active--;
    return done;
  });
  t.consumer.start();
  t.send('message');
  if (order === 'tick-first') vi.advanceTimersByTime(1000);
  const direct = t.consumer.run('direct');
  if (order === 'direct-first') t.consumer.tick(); // already-dispatched stale callback
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
  finish.resolve(done);
  await direct;
  expect(maximum).toBe(1);
  expect(t.execute).toHaveBeenCalledTimes(2);
  expect(t.queue).toEqual([]);
  expect(vi.getTimerCount()).toBe(1);
});

it('handles a stale tick and loop completion in the same timer turn', async () => {
  const t = setup();
  const finish = deferred<AgentResult>();
  t.execute.mockReturnValueOnce(finish.promise);
  const run = t.consumer.run('initial');
  t.send('next');
  setTimeout(() => { finish.resolve(done); t.consumer.tick(); }, 1000);
  await vi.advanceTimersByTimeAsync(1000);
  await run;
  expect(t.execute).toHaveBeenCalledTimes(2);
  expect(t.bus.acknowledge).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
});

it('keeps queued direct turns inside the gate with no intervening idle timer', async () => {
  const t = setup();
  const finish = deferred<AgentResult>();
  t.execute.mockImplementation(async () => {
    expect(vi.getTimerCount()).toBe(0);
    return finish.promise;
  });
  const runs = [t.consumer.run('one'), t.consumer.run('two'), t.consumer.run('three')];
  await Promise.resolve();
  expect(t.execute).toHaveBeenCalledTimes(1);
  finish.resolve(done);
  await Promise.all(runs);
  expect(t.execute.mock.calls).toEqual([['one'], ['two'], ['three']]);
  expect(vi.getTimerCount()).toBe(1);
});

it('runs different agents concurrently with independent gates', async () => {
  const a = setup('a');
  const b = setup('b');
  const finish = deferred<AgentResult>();
  a.execute.mockReturnValue(finish.promise);
  b.execute.mockReturnValue(finish.promise);
  const runs = [a.consumer.run('a'), b.consumer.run('b')];
  await Promise.resolve();
  expect(a.execute).toHaveBeenCalledTimes(1);
  expect(b.execute).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  finish.resolve(done);
  await Promise.all(runs);
  expect(vi.getTimerCount()).toBe(2);
});

it('catches a message arriving between an empty read and idle timer restoration on the next tick', async () => {
  const t = setup();
  const empty = deferred<TeamMessage | undefined>();
  t.bus.peek.mockReturnValueOnce(empty.promise);
  const run = t.consumer.run('initial');
  await Promise.resolve();
  empty.resolve(undefined);
  t.send('late');
  await run;
  expect(t.execute).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.execute).toHaveBeenCalledTimes(2);
  expect(t.queue).toEqual([]);
});

it.each(['throw', 'unfinished', 'peek', 'ack', 'fail'])('halts only the failed consumer and retains unread messages on %s failure', async kind => {
  const t = setup();
  const peer = setup('peer');
  const first = t.send('bad');
  t.send('unread');
  if (kind === 'peek') t.bus.peek.mockRejectedValueOnce(Object.assign(new Error('read failed'), { messageId: first.id }));
  else if (kind === 'ack') t.bus.acknowledge.mockRejectedValueOnce(new Error('write failed'));
  else if (kind === 'unfinished') t.execute.mockResolvedValueOnce({ ...done, finished: false });
  else t.execute.mockRejectedValueOnce(new Error('model failed'));
  if (kind === 'fail') t.bus.fail.mockRejectedValueOnce(new Error('fail storage failed'));
  t.consumer.start();
  peer.consumer.start();
  peer.send('healthy');
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.onError).toHaveBeenCalledWith(expect.objectContaining({ messageId: first.id, phase: ['peek', 'ack'].includes(kind) ? 'storage' : 'model' }));
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`message:${first.id}`));
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('agent:worker'));
  expect(t.queue.map(m => m.content)).toEqual(['bad', 'unread']);
  expect(peer.queue).toEqual([]);
  expect(vi.getTimerCount()).toBe(1);
  const attempts = t.bus.peek.mock.calls.length;
  t.consumer.start();
  t.consumer.tick();
  await vi.advanceTimersByTimeAsync(5000);
  expect(t.bus.peek).toHaveBeenCalledTimes(attempts);
  expect(() => t.consumer.run('retry')).toThrow('停止');
});

it('does not poll after a direct model error or execute already queued turns', async () => {
  const t = setup();
  t.execute.mockRejectedValueOnce(new Error('initial failed'));
  const runs = [t.consumer.run('initial'), t.consumer.run('queued')];
  expect((await Promise.allSettled(runs)).every(r => r.status === 'rejected')).toBe(true);
  expect(t.execute).toHaveBeenCalledTimes(1);
  expect(t.bus.peek).not.toHaveBeenCalled();
  expect(t.onError).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['idle', 'running', 'peek', 'tick-admitted'])('stop is idempotent and never resurrects timers from %s', async state => {
  const t = setup();
  const finish = deferred<AgentResult>();
  const head = deferred<TeamMessage | undefined>();
  const message = t.send('unread');
  t.consumer.start();
  let run: Promise<unknown> | undefined;
  if (state === 'running') {
    t.execute.mockReturnValue(finish.promise);
    run = t.consumer.run('initial');
    await Promise.resolve();
  } else if (state === 'peek') {
    t.bus.peek.mockReturnValueOnce(head.promise);
    t.consumer.tick();
    await Promise.resolve();
  } else if (state === 'tick-admitted') t.consumer.tick();
  const stop = t.consumer.stop();
  expect(t.consumer.stop()).toBe(stop);
  finish.resolve(done);
  head.resolve(message);
  await stop;
  await run;
  t.consumer.start();
  t.consumer.tick();
  await vi.advanceTimersByTimeAsync(5000);
  expect(vi.getTimerCount()).toBe(0);
  expect(t.onError).not.toHaveBeenCalled();
  expect(t.queue).toEqual([message]);
  expect(t.execute).toHaveBeenCalledTimes(state === 'running' ? 1 : 0);
});

it('iteratively drains a large inbox without growing the call stack', async () => {
  const t = setup();
  for (let i = 0; i < 3000; i++) t.send(String(i));
  await t.consumer.run('initial');
  expect(t.execute).toHaveBeenCalledTimes(3001);
  expect(t.queue).toEqual([]);
});


it('finishes and acknowledges an in-flight message on stop without draining the next head', async () => {
  const t = setup();
  const finish = deferred<AgentResult>();
  t.execute.mockReturnValueOnce(finish.promise);
  const first = t.send('running');
  const unread = t.send('unread');
  t.consumer.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.execute).toHaveBeenCalledTimes(1);
  const stopping = t.consumer.stop();
  finish.resolve(done);
  await stopping;
  expect(t.bus.acknowledge).toHaveBeenCalledWith('worker', first.id);
  expect(t.queue).toEqual([unread]);
  expect(vi.getTimerCount()).toBe(0);
});


it('preserves inbox polling deadlines across empty cron ticks on the shared gate', async () => {
  const t = setup('main');
  const scheduler = { create: vi.fn(), cancel: vi.fn(), list: vi.fn(), take: vi.fn().mockResolvedValue(undefined), finish: vi.fn() };
  const cron = new CronConsumer(scheduler, t.turns, vi.fn(), vi.fn());
  // Cron's interval is registered first, just as in the CLI.
  cron.start();
  t.consumer.start();
  try {
    for (let i = 0; i < 4; i++) {
      t.send(`message-${i}`);
      await vi.advanceTimersByTimeAsync(1001);
      expect(t.queue).toEqual([]);
    }
    expect(scheduler.take).toHaveBeenCalledTimes(4);
    expect(t.execute).toHaveBeenCalledTimes(4);
    const release = deferred<void>();
    const external = t.turns.run(() => release.promise);
    expect(vi.getTimerCount()).toBe(1); // only cron's interval; inbox is suspended
    t.consumer.tick(); // stale callback while another entry point owns the gate
    release.resolve();
    await external;
    t.send('after external turn');
    await vi.advanceTimersByTimeAsync(1001);
    expect(t.queue).toEqual([]);
  } finally { await cron.stop(); }
});

it('executes cron within its existing reservation and drains immediately without a nested gate', async () => {
  const t = setup('main');
  t.send('report');
  const job = { id: 'cron', prompt: 'scheduled', drauble: false, recurring: false, cron: '* * * * * *' };
  const scheduler = { create: vi.fn(), cancel: vi.fn(), list: vi.fn(), take: vi.fn().mockResolvedValueOnce(job), finish: vi.fn() };
  const error = vi.fn();
  const cron = new CronConsumer(scheduler, t.turns, async job => { await t.consumer.runInTurn(job.prompt); }, error);
  cron.tick();
  await vi.advanceTimersByTimeAsync(0);
  await cron.stop();
  expect(t.execute.mock.calls.map(([input]) => input.startsWith('{') ? JSON.parse(input).message.content : input))
    .toEqual(['scheduled', 'report']);
  expect(error).not.toHaveBeenCalled();
  expect(scheduler.finish).toHaveBeenCalledWith('cron');
  expect(t.turns.busy).toBe(false);
  expect(() => t.consumer.runInTurn('outside gate')).toThrow('gate');
});


it('yields a continuously replenished main inbox to user input and cron', async () => {
  const t = setup('main', { maxMessagesPerTurn: 2, haltOnDirectError: false });
  const first = deferred<AgentResult>();
  t.send('seed');
  t.execute.mockImplementation(async input => {
    if (input === 'user') return done;
    t.send('more');
    return first.promise;
  });
  t.consumer.tick();
  await Promise.resolve();
  await Promise.resolve();
  const user = t.consumer.run('user');
  first.resolve(done);
  await user;
  expect(t.execute.mock.calls[1]).toEqual(['user']);
  expect(t.queue.length).toBeGreaterThan(0);
  expect(t.turns.busy).toBe(false);
  const cron = vi.fn(async () => {});
  await t.turns.runIfIdle(cron);
  expect(cron).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.queue.length).toBeGreaterThan(0);
  expect(t.turns.busy).toBe(false);
});

it('keeps main usable after a direct cron failure but still halts a failing inbox head', async () => {
  const t = setup('main', { haltOnDirectError: false });
  t.execute.mockRejectedValueOnce(new Error('cron failed'));
  await expect(t.turns.run(() => t.consumer.runInTurn('cron'))).rejects.toThrow('cron failed');
  await expect(t.consumer.run('user')).resolves.toEqual(done);
  const head = t.send('bad inbox');
  t.execute.mockRejectedValueOnce(new Error('inbox failed'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.onError).toHaveBeenCalledWith(expect.objectContaining({ messageId: head.id }));
  expect(t.queue).toEqual([head]);
});
