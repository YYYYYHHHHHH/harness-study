import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TaskStore, taskHandlers } from '../src/tools/tasks.js';
import type { ToolContext } from '../src/tools/dispatch.js';
const exec = promisify(execFile);
let dir: string;
let store: TaskStore;
const task = (taskid: string, depends: string[] = [], status = 'wait') => ({ taskid, description: `任务 ${taskid}`, status, depends });
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'harness-tasks-')); store = new TaskStore(dir); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

describe('persistent task store', () => {
  it('returns empty tasks for an empty workspace', async () => { expect(await store.get()).toEqual([]); });
  it('writes individual timestamp-random JSON files and reads across instances', async () => {
    await store.create([task('a'), task('b', ['a'])]);
    const files = await readdir(join(dir, '.task'));
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(file).toMatch(/^\d+-[\da-f-]+\.json$/);
      expect(JSON.parse(await readFile(join(dir, '.task', file), 'utf8'))).toMatchObject({ owner: null });
    }
    expect(await new TaskStore(dir).get(['b', 'a'])).toEqual([
      { ...task('b', ['a']), owner: null }, { ...task('a'), owner: null },
    ]);
  });
  it('blocks dependencies then claims and completes while preserving owner', async () => {
    await store.create([task('a'), task('b', ['a'])]);
    await expect(store.claim('b', 'agent-2')).rejects.toThrow('前置依赖未完成');
    expect(await store.claim('a', 'agent-1')).toMatchObject({ status: 'procing', owner: 'agent-1' });
    await store.complete(['a']);
    expect(await store.claim('b', 'agent-2')).toMatchObject({ status: 'procing', owner: 'agent-2' });
    await store.complete(['b']);
    expect(await new TaskStore(dir).get(['b'])).toEqual([{ ...task('b', ['a'], 'compleate'), owner: 'agent-2' }]);
  });
  it('rejects an owned task and a non-wait task', async () => {
    await store.create([task('a'), task('b', [], 'procing'), task('c', [], 'compleate')]);
    await store.claim('a', 'one');
    await expect(store.claim('a', 'two')).rejects.toThrow('已有 owner');
    for (const id of ['b', 'c']) await expect(store.claim(id, 'one')).rejects.toThrow('不是 wait');
  });
  it('has exactly one winner for concurrent claims', async () => {
    await store.create([task('a')]);
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => new TaskStore(dir).claim('a', `agent-${i}`)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await store.get(['a']))[0]?.status).toBe('procing');
  });
  it('supports independent process claims and process restart persistence', async () => {
    await store.create([task('a')]);
    const moduleUrl = pathToFileURL(resolve('src/tools/tasks.ts')).href;
    const loader = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
    const script = `import { TaskStore } from ${JSON.stringify(moduleUrl)}; try { await new TaskStore().claim('a', process.argv[1]); console.log('won'); } catch { console.log('blocked'); }`;
    const results = await Promise.all(['one', 'two'].map(owner => exec(process.execPath, ['--import', loader, '--input-type=module', '-e', script, owner], { cwd: dir })));
    expect(results.map(r => r.stdout.trim()).sort()).toEqual(['blocked', 'won']);
    const read = await exec(process.execPath, ['--import', loader, '--input-type=module', '-e', `import { TaskStore } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await new TaskStore().get()));`], { cwd: dir });
    expect(JSON.parse(read.stdout)[0]).toMatchObject({ taskid: 'a', status: 'procing' });
  });
  it('rejects duplicate IDs without partial creation', async () => {
    await expect(store.create([task('a'), task('a')])).rejects.toThrow('重复');
    expect(await store.get()).toEqual([]);
    await store.create([task('a')]);
    await expect(store.create([task('b'), task('a')])).rejects.toThrow('已存在');
    await expect(store.get(['b'])).rejects.toThrow('不存在');
  });
  it('rejects missing dependencies and cycles, including self-dependency', async () => {
    await expect(store.create([task('a', ['missing'])])).rejects.toThrow('不存在');
    await expect(store.create([task('a', ['a'])])).rejects.toThrow('循环');
    await expect(store.create([task('a', ['b']), task('b', ['a'])])).rejects.toThrow('循环');
    expect(await store.get()).toEqual([]);
  });
  it('supports existing dependencies and forward references within one batch', async () => {
    await store.create([task('a', [], 'compleate')]);
    await store.create([task('c', ['b']), task('b', ['a'])]);
    expect(await store.claim('b', 'owner')).toMatchObject({ status: 'procing' });
  });
  it('validates all completion IDs before writing and completion is idempotent', async () => {
    await store.create([task('a'), task('b')]);
    await expect(store.complete(['a', 'missing'])).rejects.toThrow('不存在');
    expect((await store.get(['a']))[0]?.status).toBe('wait');
    expect(await store.complete(['a', 'b'])).toEqual(await store.complete(['a', 'b']));
  });
  it('handles empty selection and rejects unknown selections', async () => {
    expect(await store.get([])).toEqual([]);
    await expect(store.get(['missing'])).rejects.toThrow('不存在');
    await expect(store.claim('missing', 'owner')).rejects.toThrow('不存在');
  });
  it.each([null, [], {}, [null], [task('')], [{ ...task('a'), description: '' }],
    [{ ...task('a'), status: 'complete' }], [{ ...task('a'), depends: 'a' }],
    [{ ...task('a'), depends: ['x', 'x'] }], [{ ...task('a'), owner: 'spoofed' }],
  ])('rejects malformed creation %#', async value => { await expect(store.create(value)).rejects.toThrow(); });
  it('validates selection and owner types', async () => {
    for (const value of [null, 'a', [1], ['a', 'a']]) {
      await expect(store.get(value)).rejects.toThrow();
      await expect(store.complete(value)).rejects.toThrow();
    }
    await expect(store.complete([])).rejects.toThrow();
    await expect(store.claim([], 'owner')).rejects.toThrow();
    await expect(store.claim('a', '')).rejects.toThrow();
  });
  it('does not interpret task IDs as paths', async () => {
    await store.create([task('../../outside')]);
    await store.claim('../../outside', 'main');
    expect(await store.get(['../../outside'])).toHaveLength(1);
    expect(await readdir(dir)).toEqual(['.task']);
  });
  it('reports corruption rather than silently returning an empty store', async () => {
    await mkdir(join(dir, '.task'));
    await writeFile(join(dir, '.task', 'broken.json'), '{');
    await expect(store.get()).rejects.toThrow('任务文件损坏');
    expect(await readdir(join(dir, '.task'))).toEqual(['broken.json']);
  });
  it('rejects symlink task files and directories', async () => {
    await mkdir(join(dir, '.task'));
    await writeFile(join(dir, 'outside.json'), '{}');
    await symlink(join(dir, 'outside.json'), join(dir, '.task', 'link.json'));
    await expect(store.get()).rejects.toThrow('不是普通文件');
    await rm(join(dir, '.task'), { recursive: true });
    await mkdir(join(dir, 'elsewhere'));
    await symlink(join(dir, 'elsewhere'), join(dir, '.task'));
    await expect(store.get()).rejects.toThrow('符号链接');
  });
  it('releases lock after validation failure and ignores incomplete temporary files', async () => {
    await store.get();
    await writeFile(join(dir, '.task', 'interrupted.tmp'), '{');
    await expect(store.claim('missing', 'owner')).rejects.toThrow();
    await store.create([task('a')]);
    expect(await readdir(join(dir, '.task'))).not.toContain('.lock');
  });
});

it('wires all four handlers and derives owner from trusted context, not arguments', async () => {
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  const context = { agentId: 'main', runId: 'run-1' } as ToolContext;
  const call = async (name: string, args: Record<string, unknown>, ctx = context) => JSON.parse(await taskHandlers[name]!(args, ctx));
  expect(await call('create_tasks', { tasks: [task('a'), task('b')] })).toMatchObject({ ok: true });
  expect((await call('clamic_task', { task_id: 'a', owner: 'spoofed' })).task.owner).toBe('main');
  expect((await call('clamic_task', { task_id: 'b' }, { runId: 'fallback' } as ToolContext)).task.owner).toBe('fallback');
  expect((await call('complate_tasks', { task_id: ['a', 'b'] })).tasks.every((t: any) => t.status === 'compleate')).toBe(true);
  expect((await call('get_tasks_detail', {})).tasks).toHaveLength(2);
});
