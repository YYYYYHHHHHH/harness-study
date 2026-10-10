import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, glob as fsGlob } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import chalk from 'chalk';

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

export async function runTodoWrite(todos: TodoItem[]): Promise<string> {
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

  const header = chalk.cyan.bold('📋 TODO 计划');
  console.log('\n' + header);
  console.log(lines.join('\n') + '\n');

  return JSON.stringify({ ok: true, count: todos.length, todos });
}
