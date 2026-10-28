import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../src/tools/bash.js', () => ({ executeBash: vi.fn() }));
import { executeBash, type BashResult } from '../src/tools/bash.js';
import { startBackgroundBash, takeBackgroundNotifications, type BackgroundTaskMap } from '../src/background-tasks.js';

afterEach(() => vi.resetAllMocks());

it('returns immediately and records metadata before execution finishes', async () => {
  const pending = Promise.withResolvers<BashResult>();
  vi.mocked(executeBash).mockReturnValue(pending.promise);
  const bg_task_map: BackgroundTaskMap = new Map();
  const started = Date.now();
  const response = startBackgroundBash(bg_task_map, 'slow command', 'tool-123');
  const [task] = [...bg_task_map.values()];
  expect(response).toBe(`[任务已在后台执行中]bgid：${task.bg_task_id}`);
  expect(task).toMatchObject({ command: 'slow command', origin_tool_id: 'tool-123', status: 'running', result: null, notified: false });
  expect(task.started_at).toBeGreaterThanOrEqual(started);
  expect(task.started_at).toBeLessThanOrEqual(Date.now());
  expect(takeBackgroundNotifications(bg_task_map)).toEqual([]);
  pending.resolve({ status: 'completed', result: 'done' });
  await pending.promise;
  expect(task).toMatchObject({ status: 'completed', result: 'done' });
  expect(takeBackgroundNotifications(bg_task_map)).toEqual([
    `<notify_bg_task><task_id>${task.bg_task_id}</task_id><task_result>done</task_result><origin_tool_id>tool-123</origin_tool_id></notify_bg_task>`,
  ]);
  expect(takeBackgroundNotifications(bg_task_map)).toEqual([]);
  expect(bg_task_map.get(task.bg_task_id)).toMatchObject({ result: 'done', notified: true });
});

it('keeps concurrent tasks distinct and notifies failures and successes independently', async () => {
  const first = Promise.withResolvers<BashResult>();
  const second = Promise.withResolvers<BashResult>();
  vi.mocked(executeBash).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const bg_task_map: BackgroundTaskMap = new Map();
  startBackgroundBash(bg_task_map, 'first', 'tool-1');
  startBackgroundBash(bg_task_map, 'second', 'tool-2');
  expect(bg_task_map.size).toBe(2);
  second.resolve({ status: 'failed', result: 'Error: Timeout (120s)' });
  await second.promise;
  const notifications = takeBackgroundNotifications(bg_task_map);
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toContain('<task_result>Error: Timeout (120s)</task_result><origin_tool_id>tool-2</origin_tool_id>');
  expect([...bg_task_map.values()].map(task => task.status)).toEqual(['running', 'failed']);
  first.resolve({ status: 'completed', result: 'Error: this is successful stdout' });
  await first.promise;
  expect(takeBackgroundNotifications(bg_task_map)).toHaveLength(1);
  expect([...bg_task_map.values()][0].status).toBe('completed');
});

it('escapes XML and replaces invalid XML control characters while retaining the raw result', async () => {
  const result = '</task_result><fake>&"\'\u001b\u0000\n中文😀';
  vi.mocked(executeBash).mockResolvedValue({ status: 'completed', result });
  const bg_task_map: BackgroundTaskMap = new Map();
  startBackgroundBash(bg_task_map, 'output xml', 'tool<&>');
  await Promise.resolve();
  const [notification] = takeBackgroundNotifications(bg_task_map);
  expect(notification).toContain('<task_result>&lt;/task_result&gt;&lt;fake&gt;&amp;&quot;&apos;��\n中文😀</task_result>');
  expect(notification).toContain('<origin_tool_id>tool&lt;&amp;&gt;</origin_tool_id>');
  expect([...bg_task_map.values()][0].result).toBe(result);
});
