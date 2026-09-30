import { resolve, relative, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import chalk from 'chalk';

const WORKDIR = process.cwd();

const HARD_DENY_PATTERNS = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];

function isInsideWorkdir(path: string): boolean {
  const absolute = isAbsolute(path) ? path : resolve(WORKDIR, path);
  const rel = relative(WORKDIR, absolute);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

export type PermissionResult =
  | { allowed: true }
  | { allowed: false; reason: string };

interface AskRule {
  toolName: string;
  check: (args: Record<string, unknown>) => string | null;
}

const askRules: AskRule[] = [
  {
    toolName: 'read_file',
    check: (args) => {
      const path = args.path;
      if (typeof path === 'string' && !isInsideWorkdir(path)) {
        return `read_file 试图读取工作目录之外的文件：${path}`;
      }
      return null;
    },
  },
  {
    toolName: 'write_file',
    check: (args) => {
      const path = args.path;
      if (typeof path === 'string' && !isInsideWorkdir(path)) {
        return `write_file 试图写入工作目录之外的文件：${path}`;
      }
      return null;
    },
  },
  {
    toolName: 'edit_file',
    check: (args) => {
      const path = args.path;
      if (typeof path === 'string' && !isInsideWorkdir(path)) {
        return `edit_file 试图修改工作目录之外的文件：${path}`;
      }
      return null;
    },
  },
];

async function askUser(reason: string, name: string, args: unknown): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log(chalk.yellow.bold('\n⚠ 权限询问'));
    console.log(`  ${chalk.yellow('原因:')} ${reason}`);
    console.log(`  ${chalk.gray('工具:')} ${chalk.cyan(name)}`);
    console.log(`  ${chalk.gray('参数:')} ${chalk.gray(JSON.stringify(args))}`);
    const answer = await rl.question(chalk.yellow.bold('是否允许执行？(y/N) '));
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

export async function checkPermission(
  name: string,
  argumentsJson: string,
): Promise<PermissionResult> {
  let args: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(argumentsJson);
    if (typeof raw === 'object' && raw !== null) {
      args = raw as Record<string, unknown>;
    }
  } catch {
    // 参数解析失败交给 dispatch 处理，权限层直接放行
    return { allowed: true };
  }

  if (name === 'bash') {
    const command = typeof args.command === 'string' ? args.command : '';
    const hit = HARD_DENY_PATTERNS.find(p => command.includes(p));
    if (hit) {
      return {
        allowed: false,
        reason: `Permission denied: bash 命令命中固定拒绝名单 "${hit}"`,
      };
    }
  }

  for (const rule of askRules) {
    if (rule.toolName !== name) continue;
    const reason = rule.check(args);
    if (reason) {
      const approved = await askUser(reason, name, args);
      if (!approved) {
        return {
          allowed: false,
          reason: `Permission denied by user: ${reason}`,
        };
      }
    }
  }

  return { allowed: true };
}
