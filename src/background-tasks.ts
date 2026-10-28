import { randomUUID } from 'node:crypto';
import { executeBash } from './tools/bash.js';

export interface BackgroundTask {
  command: string;
  /** Unix timestamp in milliseconds. */
  started_at: number;
  bg_task_id: string;
  status: 'running' | 'completed' | 'failed';
  result: string | null;
  origin_tool_id: string;
  notified: boolean;
}

export type BackgroundTaskMap = Map<string, BackgroundTask>;

export function startBackgroundBash(
  bg_task_map: BackgroundTaskMap, command: string, origin_tool_id: string,
): string {
  const bg_task_id = randomUUID();
  const task: BackgroundTask = {
    command, started_at: Date.now(), bg_task_id, status: 'running', result: null,
    origin_tool_id, notified: false,
  };
  bg_task_map.set(bg_task_id, task);
  // executeBash captures process failures, including timeout, as terminal results.
  void executeBash(command).then(outcome => {
    task.result = outcome.result;
    task.status = outcome.status;
  });
  return `[任务已在后台执行中]bgid：${bg_task_id}`;
}

function escapeXml(value: string): string {
  // XML 1.0 does not allow shell control characters (e.g. ANSI escape bytes).
  return value.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '\uFFFD')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function hasCompletedBackgroundTasks(bg_task_map: BackgroundTaskMap): boolean {
  return [...bg_task_map.values()].some(task => task.status !== 'running' && !task.notified);
}

/** Consume each terminal result once, retaining the record for inspection. */
export function takeBackgroundNotifications(bg_task_map: BackgroundTaskMap): string[] {
  const notifications: string[] = [];
  for (const task of bg_task_map.values()) {
    if (task.status === 'running' || task.notified) continue;
    notifications.push(
      `<notify_bg_task><task_id>${escapeXml(task.bg_task_id)}</task_id>` +
      `<task_result>${escapeXml(task.result ?? '')}</task_result>` +
      `<origin_tool_id>${escapeXml(task.origin_tool_id)}</origin_tool_id></notify_bg_task>`,
    );
    task.notified = true;
  }
  return notifications;
}
