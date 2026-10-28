import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type OpenAI from 'openai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/agent.js', () => ({ runAgent: vi.fn() }));
import { tools } from '../src/tools/index.js';
import { dispatchTool, type ToolContext } from '../src/tools/dispatch.js';
import { CronEngine } from '../src/cron/engine.js';

let directory: string;
let engine: CronEngine;
let context: ToolContext;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'harness-cron-tools-'));
  engine = new CronEngine(directory);
  context = {
    client: {} as OpenAI, model: 'test', tools, logPrefix: '', runId: 'test', skills: new Map(),
    cron: {
      create: async args => engine.create(args), cancel: async id => engine.cancel(id), list: async () => engine.list(),
      take: async () => engine.take(), finish: async id => engine.finish(id),
    },
  };
});
afterEach(() => {
  engine.close();
  rmSync(directory, { recursive: true, force: true });
});
const input = { prompt: '提醒我检查构建', drauble: true, recurring: false, cron: '*/5 * * * *' };
const dispatch = async (name: string, args: unknown) => JSON.parse(await dispatchTool(name, JSON.stringify(args), context));

it('creates, lists and cancels through the registered tools using generated IDs', async () => {
  const created = await dispatch('create_cron_job', input);
  expect(created).toMatchObject({ ok: true, job: input });
  expect(created.job.id).toEqual(expect.any(String));
  expect(await dispatch('list_cron_job', {})).toMatchObject({ ok: true, jobs: [{ ...created.job, status: 'scheduled' }] });
  expect(await dispatch('cancel_cron_job', { id: created.job.id })).toEqual({ ok: true, cancelled: true });
  expect(await dispatch('cancel_cron_job', { id: created.job.id })).toEqual({ ok: true, cancelled: false });
  expect(await dispatch('list_cron_job', {})).toEqual({ ok: true, jobs: [] });
});

it.each([
  { prompt: '' }, { prompt: 1 }, { drauble: 'true' }, { recurring: 1 }, { cron: '' }, { cron: 'bad' }, { id: 'custom' },
])('validates create arguments %j before scheduling', async override => {
  await expect(dispatch('create_cron_job', { ...input, ...override })).rejects.toThrow();
  expect(engine.list()).toEqual([]);
});

it.each([{}, { id: '' }, { id: 42 }, { id: 'job', extra: true }])('rejects invalid cancel %j', async args => {
  await expect(dispatch('cancel_cron_job', args)).rejects.toThrow(/id/);
});

it('rejects list arguments and reports a missing runtime service', async () => {
  await expect(dispatch('list_cron_job', { id: 'x' })).rejects.toThrow(/不接受参数/);
  context.cron = undefined;
  await expect(dispatch('list_cron_job', {})).rejects.toThrow(/未启动/);
});
