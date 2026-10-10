import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, glob as fsGlob } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import chalk from 'chalk';
import { runAgent } from '../agent.js';
import type { ToolContext, ToolHandler } from './dispatch.js';

export type TodoStatus = '未开始' | '进行中' | '已完成';
export interface TodoItem {
  content: string;
  status: TodoStatus;
}

const execAsync = promisify(exec);
const WORKDIR = process.cwd();

function toAbsolute(path: string): string {
  return isAbsolute(path) ? path : resolve(WORKDIR, path);
}

export async function runBash(command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: WORKDIR,
      timeout: 120000,
    });
    const out = (stdout + stderr).trim();
    return out ? out.slice(0, 50000) : '(no output)';
  } catch (error: any) {
    if (error.killed) {
      return 'Error: Timeout (120s)';
    }
    return `Error: ${error.message}`;
  }
}

export async function runRead(path: string, limit?: number): Promise<string> {
  const text = await readFile(toAbsolute(path), 'utf-8');
  const lines = text.split('\n');
  const sliced = typeof limit === 'number' ? lines.slice(0, limit) : lines;
  return sliced.join('\n');
}

export async function runWrite(path: string, content: string): Promise<string> {
  await writeFile(toAbsolute(path), content, 'utf-8');
  return `Wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${path}`;
}

export async function runEdit(path: string, oldText: string, newText: string): Promise<string> {
  const absolute = toAbsolute(path);
  const text = await readFile(absolute, 'utf-8');
  if (!text.includes(oldText)) {
    return 'Error: text not found';
  }
  await writeFile(absolute, text.replace(oldText, newText), 'utf-8');
  return `Edited ${path}`;
}

export async function runGlob(pattern: string): Promise<string> {
  const results: string[] = [];
  for await (const entry of fsGlob(pattern, { cwd: WORKDIR })) {
    results.push(entry);
  }
  return results.length ? results.join('\n') : '(no matches)';
}

export async function runTodoWrite(todos: TodoItem[], logPrefix = ''): Promise<string> {
  const lines = todos.map((todo, index) => {
    const num = chalk.gray(`${index + 1}.`);
    let icon: string;
    let text: string;
    switch (todo.status) {
      case '已完成':
        icon = chalk.green('✔');
        text = chalk.gray.strikethrough(todo.content);
        break;
      case '进行中':
        icon = chalk.yellow('◐');
        text = chalk.white.bold(todo.content);
        break;
      default:
        icon = chalk.gray('○');
        text = chalk.white(todo.content);
    }
    const tag = chalk.gray(`[${todo.status}]`);
    return `  ${num} ${icon} ${text} ${tag}`;
  });

  const header = `${logPrefix ? logPrefix + ' ' : ''}${chalk.cyan.bold('📋 TODO 计划')}`;
  console.log('\n' + header);
  console.log(lines.join('\n') + '\n');

  return JSON.stringify({ ok: true, count: todos.length, todos });
}

export async function runSpawnSubagent(subagentName: string, task: string, context: ToolContext): Promise<string> {
  const tag = chalk.magenta(`[subagent:${subagentName}]`);
  console.log(`\n${tag} ${chalk.cyan('▶ 启动')} ${chalk.gray('任务:')} ${chalk.white(task)}`);
  const tools = context.tools.filter(tool => tool.schema.function.name !== 'spawn_subagent');
  const systemPrompt = `你是一个名为「${subagentName}」的 subagent，由主 agent 派发任务给你。
你的工作目录是 ${process.cwd()}。
可用工具：${tools.map(tool => tool.schema.function.name).join('、')}。你无法再派发 subagent。

工作要求：
1. 仅聚焦主 agent 交给你的本次任务，不要越权做无关的事。
2. 开始动手前先用 todo_write 规划步骤，并按 未开始/进行中/已完成 更新状态；同一时间最多一个「进行中」。
3. 遇到无法完成的情况，诚实说明原因与已尝试的步骤。
4. 完成后，用一段清晰、紧凑的中文总结输出最终结果——这段文本会直接作为工具返回值交给主 agent，所以要点要齐全、不要冗余过程日志。`;
  const result = await runAgent({
    client: context.client,
    model: context.model,
    input: task,
    systemPrompt,
    tools,
    logPrefix: tag,
  });
  if (!result.finished) {
    const error = `subagent「${subagentName}」超过最大轮次 ${result.rounds} 未完成任务`;
    console.log(`${tag} ${chalk.red('✗ ' + error)}`);
    return JSON.stringify({ ok: false, error });
  }
  const summary = result.finalContent?.trim() || '(subagent 未返回总结)';
  console.log(`${tag} ${chalk.green('✔ 完成')} ${chalk.gray('返回主 agent:')} ${chalk.white(summary.slice(0, 120))}${summary.length > 120 ? chalk.gray('…') : ''}`);
  return summary;
}

const TODO_STATUSES: readonly TodoStatus[] = ['未开始', '进行中', '已完成'];

function requireString(args: Record<string, unknown>, key: string, toolName: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`${toolName} 的 ${key} 参数无效`);
  return value;
}

export const toolHandlers: Record<string, ToolHandler> = {
  bash: args => runBash(requireString(args, 'command', 'bash')),
  read_file: args => {
    const path = requireString(args, 'path', 'read_file');
    const limit = args.limit;
    if (limit !== undefined && typeof limit !== 'number') {
      throw new Error('read_file 的 limit 参数必须是数字');
    }
    return runRead(path, limit);
  },
  write_file: args => runWrite(
    requireString(args, 'path', 'write_file'),
    requireString(args, 'content', 'write_file'),
  ),
  edit_file: args => runEdit(
    requireString(args, 'path', 'edit_file'),
    requireString(args, 'old_text', 'edit_file'),
    requireString(args, 'new_text', 'edit_file'),
  ),
  glob: args => runGlob(requireString(args, 'pattern', 'glob')),
  todo_write: (args, context) => {
    if (!Array.isArray(args.todos)) throw new Error('todo_write 的 todos 参数必须是数组');
    const todos: TodoItem[] = args.todos.map((item, idx) => {
      if (typeof item !== 'object' || item === null) {
        throw new Error(`todo_write 的 todos[${idx}] 不是对象`);
      }
      const { content, status } = item as Record<string, unknown>;
      if (typeof content !== 'string') {
        throw new Error(`todo_write 的 todos[${idx}].content 必须是字符串`);
      }
      if (typeof status !== 'string' || !TODO_STATUSES.includes(status as TodoStatus)) {
        throw new Error(`todo_write 的 todos[${idx}].status 必须是 ${TODO_STATUSES.join('/')} 之一`);
      }
      return { content, status: status as TodoStatus };
    });
    return runTodoWrite(todos, context.logPrefix);
  },
  spawn_subagent: (args, context) => runSpawnSubagent(
    requireString(args, 'subagent_name', 'spawn_subagent'),
    requireString(args, 'task', 'spawn_subagent'),
    context,
  ),
};
