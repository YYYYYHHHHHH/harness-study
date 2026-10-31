import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBus } from '../src/agent-team/message-bus.js';
import { encodeInboxMessage, INBOX_DIRECTORY, type TeamMessage } from '../src/agent-team/protocol.js';

const legacy: TeamMessage = { id: 'old-1', sender: 'main', target: 'worker', content: '旧消息\n第二行', created_at: '2026-10-29T00:00:00.000Z' };
let workspace: string;
let root: string;
const buses: MessageBus[] = [];
async function open() {
  const bus = await MessageBus.open(workspace);
  buses.push(bus);
  return bus;
}
async function ready() {
  const bus = await open();
  await bus.register('main');
  await bus.register('worker');
  return bus;
}
const send = (bus: MessageBus, content = 'hello') => bus.append({ sender: 'main', target: 'worker', content });
const disk = () => fs.readFile(join(root, 'worker.jsonl'), 'utf8');

beforeEach(async () => {
  workspace = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'message-bus-'));
  root = join(workspace, INBOX_DIRECTORY);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const bus of buses.splice(0)) await bus.close().catch(() => {});
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('FIFO and atomic consumption', () => {
  it('creates missing inboxes, takes one at a time, and preserves appends during a reservation', async () => {
    const bus = await ready();
    expect(await bus.peek('worker')).toBeUndefined();
    const first = await send(bus, 'first');
    expect(await bus.peek('worker')).toEqual(first);
    await expect(bus.peek('worker')).rejects.toMatchObject({ code: 'RESERVED', messageId: first.id });
    await expect(bus.acknowledge('worker', 'wrong-id')).rejects.toMatchObject({ code: 'RESERVATION_MISMATCH' });
    const second = await send(bus, 'second');
    expect((await disk()).split('\n')).toHaveLength(3);
    await bus.acknowledge('worker', first.id);
    expect(await bus.peek('worker')).toEqual(second);
    await bus.acknowledge('worker', second.id);
    expect(await disk()).toBe('');
    await expect(bus.acknowledge('worker', second.id)).rejects.toMatchObject({ code: 'RESERVATION_MISMATCH' });
  });

  it('interleaves multiple producers and competing consumers without loss or duplicates', async () => {
    const bus = await ready();
    for (const name of ['one', 'two', 'three']) await bus.register(name);
    const sent: TeamMessage[] = [];
    const taken: TeamMessage[] = [];
    let producing = true;
    const producers = ['one', 'two', 'three'].map(async sender => {
      for (let i = 0; i < 20; i++) {
        sent.push(await bus.append({ sender, target: 'worker', content: `${sender}:${i}` }));
      }
    });
    const consume = async () => {
      while (producing || taken.length < 60) {
        let message: TeamMessage | undefined;
        try { message = await bus.peek('worker'); }
        catch (error) { if ((error as { code: string }).code !== 'RESERVED') throw error; }
        if (message) {
          taken.push(message);
          await new Promise(resolve => setImmediate(resolve));
          await bus.acknowledge('worker', message.id);
        } else await new Promise(resolve => setImmediate(resolve));
      }
    };
    const consumers = [consume(), consume()];
    await Promise.all(producers);
    producing = false;
    await Promise.all(consumers);
    expect(taken).toEqual(sent);
    expect(new Set(taken.map(message => message.id)).size).toBe(60);
    expect(await disk()).toBe('');
  }, 15_000);

  it('protects internal reservations from caller mutation and accepts self/main routing', async () => {
    const bus = await ready();
    const input = { sender: 'worker', target: 'main', content: 'response' };
    const pending = bus.append(input);
    input.content = 'changed';
    expect((await pending).content).toBe('response');
    const head = (await bus.peek('main'))!;
    const id = head.id;
    head.id = 'mutated';
    await bus.acknowledge('main', id);
    const self = await bus.append({ sender: 'main', target: 'main', content: 'self' });
    expect(await bus.peek('main')).toEqual(self);
  });
});

describe('reopen, recovery and failed runs', () => {
  it.each([true, false])('preserves legacy bytes with trailing newline=%s until explicit recovery', async newline => {
    await fs.mkdir(root);
    const text = encodeInboxMessage(legacy).replace(/\n$/, newline ? '\n' : '');
    await fs.writeFile(join(root, 'worker.jsonl'), text);
    const bus = await open();
    await expect(bus.register('worker')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', messageId: legacy.id });
    expect(await disk()).toBe(text);
    await bus.register('worker', { recover: true });
    await bus.register('main');
    await send(bus, 'later');
    expect(await bus.peek('worker')).toEqual(legacy);
    await bus.acknowledge('worker', legacy.id);
    expect((await bus.peek('worker'))?.content).toBe('later');
  });

  it('retains a failed message, blocks further execution/sending, and requires recovery after reopen', async () => {
    const bus = await ready();
    const first = await send(bus);
    await bus.peek('worker');
    const cause = new Error('model failed');
    await bus.fail('worker', first.id, cause);
    expect(bus.error('worker')).toMatchObject({ code: 'CONSUMER_FAILED', messageId: first.id, cause });
    await expect(bus.peek('worker')).rejects.toBe(bus.error('worker'));
    await expect(send(bus)).rejects.toBe(bus.error('worker'));
    await expect(bus.acknowledge('worker', first.id)).rejects.toBe(bus.error('worker'));
    expect(await disk()).toBe(encodeInboxMessage(first));
    await bus.close();
    const reopened = await open();
    await expect(reopened.register('worker')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    await reopened.register('worker', { recover: true });
    expect(await reopened.peek('worker')).toEqual(first);
    await reopened.acknowledge('worker', first.id);
    await reopened.close();
    const empty = await open();
    await empty.register('worker');
    expect(await empty.peek('worker')).toBeUndefined();
  });

  it('close waits for admitted writes, rejects new work, and is idempotent', async () => {
    const bus = await ready();
    const pending = send(bus);
    const closing = bus.close();
    expect(bus.close()).toBe(closing);
    await expect(send(bus)).rejects.toMatchObject({ code: 'CLOSED' });
    const message = await pending;
    await closing;
    expect(await disk()).toBe(encodeInboxMessage(message));
    const reopened = await open();
    await reopened.register('worker', { recover: true });
    expect(await reopened.peek('worker')).toEqual(message);
  });
});

describe('path safety and corruption', () => {
  it.each(['../escape', '/tmp/escape', 'a/b', 'a\\b', '.', 'a\n', 'CON'])('rejects unsafe name %j without creating an inbox', async name => {
    const bus = await open();
    await expect(bus.register(name)).rejects.toThrow();
    expect(await fs.readdir(root)).toEqual(['.owner.lock']);
  });

  it('rejects root symlinks and ordinary files', async () => {
    const outside = join(workspace, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, root);
    await expect(open()).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await fs.readdir(outside)).toEqual([]);
    await fs.unlink(root);
    await fs.writeFile(root, 'untouched');
    await expect(open()).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await fs.readFile(root, 'utf8')).toBe('untouched');
  });

  it.each(['symlink', 'hardlink', 'directory', 'fifo'])('rejects %s inbox without touching its target', async kind => {
    const bus = await open();
    const outside = join(workspace, 'outside');
    await fs.writeFile(outside, 'untouched');
    const path = join(root, 'worker.jsonl');
    if (kind === 'symlink') await fs.symlink(outside, path);
    if (kind === 'hardlink') await fs.link(outside, path);
    if (kind === 'directory') await fs.mkdir(path);
    if (kind === 'fifo') await promisify(execFile)('mkfifo', [path]);
    await expect(bus.register('worker')).rejects.toMatchObject({ code: 'STORAGE', cause: { code: 'UNSAFE_PATH' } });
    expect(await fs.readFile(outside, 'utf8')).toBe('untouched');
  });

  it.each([
    '{', '\n', encodeInboxMessage(legacy) + '{"id":', encodeInboxMessage(legacy) + '\n',
    JSON.stringify({ ...legacy, target: 'main' }) + '\n',
    encodeInboxMessage(legacy).repeat(2), encodeInboxMessage(legacy).replace(/\n$/, '\r\n'),
    Buffer.from([0xff, 0xfe]),
  ])('reports corruption without skipping or modifying bytes: %j', async content => {
    await fs.mkdir(root);
    await fs.writeFile(join(root, 'worker.jsonl'), content);
    const before = await fs.readFile(join(root, 'worker.jsonl'));
    const bus = await open();
    await expect(bus.register('worker', { recover: true })).rejects.toMatchObject({ code: 'STORAGE', cause: { code: 'CORRUPT' } });
    expect(await fs.readFile(join(root, 'worker.jsonl'))).toEqual(before);
    await expect(bus.register('main')).resolves.toBeUndefined();
    await expect(bus.register('worker', { recover: true })).rejects.toBe(bus.error('worker'));
  });

  it('validates the entire queue before returning a valid head', async () => {
    const bus = await ready();
    await send(bus);
    await fs.appendFile(join(root, 'worker.jsonl'), '{');
    const before = await disk();
    await expect(bus.peek('worker')).rejects.toMatchObject({ code: 'STORAGE', cause: { message: expect.stringContaining('line 2') } });
    expect(await disk()).toBe(before);
  });

  it('rejects inbox substitution and root substitution during a session', async () => {
    const bus = await ready();
    const outside = join(workspace, 'outside');
    await fs.writeFile(outside, 'untouched');
    await fs.unlink(join(root, 'worker.jsonl'));
    await fs.symlink(outside, join(root, 'worker.jsonl'));
    await expect(send(bus)).rejects.toMatchObject({ code: 'STORAGE', cause: { code: 'UNSAFE_PATH' } });
    expect(await fs.readFile(outside, 'utf8')).toBe('untouched');
    await bus.close();
    const next = await open();
    await fs.rename(root, join(workspace, 'moved'));
    await fs.symlink(join(workspace, 'moved'), root);
    await expect(next.register('main')).rejects.toMatchObject({ code: 'STORAGE', cause: { code: 'UNSAFE_PATH' } });
  });
});

describe('I/O failures and ownership', () => {
  it.each(['write', 'sync'])('temporary-file %s failure leaves the original queue intact', async stage => {
    const bus = await ready();
    await send(bus);
    const before = await disk();
    const originalOpen = fs.open.bind(fs);
    const cause = Object.assign(new Error(`injected ${stage} failure`), { code: 'ENOSPC' });
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).includes('.pending-')) {
        if (stage === 'write') vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(cause);
        else vi.spyOn(handle, 'sync').mockRejectedValueOnce(cause);
      }
      return handle;
    });
    await expect(send(bus)).rejects.toMatchObject({ code: 'STORAGE', cause });
    vi.restoreAllMocks();
    expect(await disk()).toBe(before);
    expect((await fs.readdir(root)).filter(name => name.startsWith('.pending-'))).toEqual([]);
    await expect(send(bus)).rejects.toBe(bus.error('worker'));
  });

  it('stops after a post-rename directory sync failure without pretending the commit rolled back', async () => {
    const bus = await ready();
    const originalOpen = fs.open.bind(fs);
    const cause = Object.assign(new Error('directory fsync failed'), { code: 'EIO' });
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === root) vi.spyOn(handle, 'sync').mockRejectedValueOnce(cause);
      return handle;
    });
    await expect(send(bus)).rejects.toMatchObject({ code: 'STORAGE', cause });
    vi.restoreAllMocks();
    const committed = JSON.parse(await disk()) as TeamMessage;
    expect(committed.id).toBe(bus.error('worker')?.messageId);
    await expect(send(bus)).rejects.toBe(bus.error('worker'));
    expect(await disk()).toBe(encodeInboxMessage(committed));
  });

  it.each(['append', 'ack'])('atomic %s failure preserves old bytes and stops only the affected route', async operation => {
    const bus = await ready();
    const first = await send(bus);
    if (operation === 'ack') await bus.peek('worker');
    const before = await disk();
    const cause = Object.assign(new Error('injected disk failure'), { code: 'EIO' });
    const spy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(cause);
    await expect(operation === 'ack' ? bus.acknowledge('worker', first.id) : send(bus)).rejects.toMatchObject({ code: 'STORAGE', cause, messageId: expect.any(String) });
    spy.mockRestore();
    expect(await disk()).toBe(before);
    expect((await fs.readdir(root)).filter(name => name.startsWith('.pending-'))).toEqual([]);
    await expect(bus.peek('worker')).rejects.toBe(bus.error('worker'));
    await expect(bus.register('other')).resolves.toBeUndefined();
    await expect(bus.append({ sender: 'main', target: 'other', content: 'healthy' })).resolves.toMatchObject({ content: 'healthy' });
  });

  it('reports missing files and refused registration writes', async () => {
    const bus = await ready();
    await fs.unlink(join(root, 'worker.jsonl'));
    await expect(send(bus)).rejects.toMatchObject({ code: 'STORAGE', cause: { code: 'ENOENT' } });
    await bus.close();
    const reopened = await open();
    const spy = vi.spyOn(fs, 'open').mockRejectedValueOnce(Object.assign(new Error('read-only filesystem'), { code: 'EROFS' }));
    await expect(reopened.register('other')).rejects.toMatchObject({ code: 'STORAGE', cause: { code: 'EROFS' } });
    spy.mockRestore();
  });

  it('does not remove a changed head or accept unknown/duplicate routes', async () => {
    const bus = await ready();
    await expect(bus.register('worker')).rejects.toMatchObject({ code: 'REGISTERED' });
    await expect(bus.peek('missing')).rejects.toMatchObject({ code: 'UNREGISTERED' });
    await expect(bus.append({ sender: 'unknown', target: 'worker', content: 'x' })).rejects.toThrow();
    await expect(send(bus, ' ')).rejects.toThrow();
    const first = await send(bus);
    await bus.peek('worker');
    await expect(bus.fail('worker', 'wrong', new Error())).rejects.toMatchObject({ code: 'RESERVATION_MISMATCH' });
    await fs.writeFile(join(root, 'worker.jsonl'), encodeInboxMessage(legacy));
    await expect(bus.acknowledge('worker', first.id)).rejects.toMatchObject({ code: 'STORAGE', cause: { code: 'HEAD_CHANGED' } });
    expect(await disk()).toBe(encodeInboxMessage(legacy));
  });

  it('rejects same-process and separate CLI owners, releasing only on close', async () => {
    const bus = await ready();
    await expect(open()).rejects.toMatchObject({ code: 'OWNERSHIP' });
    const moduleUrl = new URL('../src/agent-team/message-bus.ts', import.meta.url).href;
    const script = `import { MessageBus } from ${JSON.stringify(moduleUrl)};
      try { const bus = await MessageBus.open(process.argv[1]); await bus.close(); process.stdout.write('opened'); }
      catch (error) { process.stdout.write(error.code); }`;
    const child = () => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, workspace]);
    expect((await child()).stdout).toBe('OWNERSHIP');
    await bus.close();
    expect((await child()).stdout).toBe('opened');
  });

  it('refuses stale locks after a process exits without close; never steals ownership', async () => {
    const moduleUrl = new URL('../src/agent-team/message-bus.ts', import.meta.url).href;
    const script = `import { MessageBus } from ${JSON.stringify(moduleUrl)}; await MessageBus.open(process.argv[1]);`;
    await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, workspace]);
    await expect(open()).rejects.toMatchObject({ code: 'OWNERSHIP' });
    expect((await fs.stat(join(root, '.owner.lock'))).isDirectory()).toBe(true);
  });
});

describe('initialization registration rollback', () => {
  it('releases only empty unused routes while preserving files, messages and reservations', async () => {
    const bus = await ready();
    expect(await bus.unregisterEmpty('unknown')).toBe(true);
    expect(await bus.unregisterEmpty('worker')).toBe(true);
    expect(await disk()).toBe('');
    await bus.register('worker');
    const message = await send(bus);
    expect(await bus.unregisterEmpty('worker')).toBe(false);
    expect(await bus.peek('worker')).toEqual(message);
    expect(await bus.unregisterEmpty('worker')).toBe(false);
    await bus.fail('worker', message.id, new Error('failed'));
    expect(await bus.unregisterEmpty('worker')).toBe(false);
    expect(await disk()).toBe(encodeInboxMessage(message));
    await bus.close();
    await expect(bus.unregisterEmpty('worker')).rejects.toMatchObject({ code: 'CLOSED' });
  });

  it('can release an empty route after an unrelated inbox becomes corrupt', async () => {
    const bus = await ready();
    await fs.writeFile(join(root, 'bad.jsonl'), 'broken\n');
    await expect(bus.register('bad')).rejects.toMatchObject({ code: 'STORAGE' });
    expect(await bus.unregisterEmpty('worker')).toBe(true);
    expect(await disk()).toBe('');
    await expect(bus.register('worker')).resolves.toBeUndefined();
    expect(await fs.readFile(join(root, 'bad.jsonl'), 'utf8')).toBe('broken\n');
  });
});
