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

it('reports killed child processes as a timeout and sets the production exec timeout', async () => {
  expect(await runBash('never executed')).toBe('Error: Timeout (120s)');
  expect(exec).toHaveBeenCalledWith(
    'never executed', { cwd: process.cwd(), timeout: 120000 }, expect.any(Function),
  );
});
