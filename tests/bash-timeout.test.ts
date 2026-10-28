import { expect, it, vi } from 'vitest';

vi.mock('../src/agent.js', () => ({ runAgent: vi.fn() }));
// Simulate exec's timeout error rather than making the suite wait 120 seconds.
vi.mock('node:child_process', () => ({
  exec: vi.fn((_command: string, _options: unknown, callback: (error: Error) => void) => {
    callback(Object.assign(new Error('command timed out'), { killed: true }));
  }),
}));
import { exec } from 'node:child_process';
import { runBash } from '../src/tools/handlers.js';
import { startBackgroundBash, takeBackgroundNotifications, type BackgroundTaskMap } from '../src/background-tasks.js';

it('reports killed child processes as a timeout and sets the production exec timeout', async () => {
  expect(await runBash('never executed')).toBe('Error: Timeout (120s)');
  expect(exec).toHaveBeenCalledWith(
    'never executed', { cwd: process.cwd(), timeout: 120000 }, expect.any(Function),
  );
});

it('records a background timeout as failed and delivers the timeout result', async () => {
  const bg_task_map: BackgroundTaskMap = new Map();
  startBackgroundBash(bg_task_map, 'never executed', 'timeout-call');
  await vi.waitFor(() => expect([...bg_task_map.values()][0].status).toBe('failed'));
  expect(takeBackgroundNotifications(bg_task_map)[0]).toContain('<task_result>Error: Timeout (120s)</task_result>');
});
