import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, glob as fsGlob } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

const execAsync = promisify(exec);
const WORKDIR = process.cwd();

function safePath(path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(WORKDIR, path);
  const rel = relative(WORKDIR, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越界，禁止访问：${path}`);
  }
  return absolute;
}

export async function runBash(command: string): Promise<string> {
  const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];
  if (dangerous.some(d => command.includes(d))) {
    return 'Error: Dangerous command blocked';
  }

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
  const text = await readFile(safePath(path), 'utf-8');
  const lines = text.split('\n');
  const sliced = typeof limit === 'number' ? lines.slice(0, limit) : lines;
  return sliced.join('\n');
}

export async function runWrite(path: string, content: string): Promise<string> {
  await writeFile(safePath(path), content, 'utf-8');
  return `Wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${path}`;
}

export async function runEdit(path: string, oldText: string, newText: string): Promise<string> {
  const absolute = safePath(path);
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
