import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import { registerHook } from './index.js';
import { formatUsage } from '../token-usage.js';

const verbose = process.env.VERBOSE === '1' || process.argv.includes('--verbose');

function truncate(text: string, max = 300): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + chalk.gray(`… (+${text.length - max} chars)`);
}

function summarizeArgs(name: string, argumentsJson: string): string {
  try {
    const args = JSON.parse(argumentsJson) as Record<string, unknown>;
    switch (name) {
      case 'bash': return typeof args.command === 'string' ? args.command : '';
      case 'read_file':
      case 'write_file':
      case 'edit_file': return typeof args.path === 'string' ? args.path : '';
      case 'glob': return typeof args.pattern === 'string' ? args.pattern : '';
      default: return '';
    }
  } catch {
    return '';
  }
}

function indent(text: string, prefix = '   │ '): string {
  return text.split('\n').map(line => chalk.gray(prefix) + line).join('\n');
}

const spinners = new Map<string, Ora>();

registerHook('PreToolUse', ({ name, argumentsJson, toolCallId, runId, logPrefix }) => {
  const summary = summarizeArgs(name, argumentsJson);
  const spinner = ora({
    text: `${logPrefix ? logPrefix + ' ' : ''}${chalk.blue('调用工具')} ${chalk.cyan.bold(name)}${summary ? chalk.gray(` — ${truncate(summary, 60)}`) : ''}`,
    spinner: 'dots',
  }).start();
  spinners.set(`${runId}:${toolCallId}`, spinner);
});

registerHook('PostToolUse', ({ name, argumentsJson, toolCallId, ok, result, denied, runId, logPrefix }) => {
  const summary = summarizeArgs(name, argumentsJson);
  const statusText = `${logPrefix ? logPrefix + ' ' : ''}${chalk.cyan.bold(name)}${summary ? chalk.gray(` — ${truncate(summary, 60)}`) : ''}`;
  const spinner = spinners.get(`${runId}:${toolCallId}`);
  spinners.delete(`${runId}:${toolCallId}`);

  if (denied) {
    spinner?.warn(`${chalk.yellow('权限拒绝')} ${statusText}`);
  } else if (ok) {
    spinner?.succeed(`${chalk.green('工具完成')} ${statusText}`);
  } else {
    spinner?.fail(`${chalk.red('工具失败')} ${statusText}`);
  }

  const detailPrefix = `${logPrefix ? logPrefix + ' ' : ''}   │ `;
  if (verbose) {
    console.log(indent(chalk.gray(`args = ${truncate(argumentsJson, 400)}`), detailPrefix));
    console.log(indent(chalk.gray(`result = ${truncate(result, 800)}`), detailPrefix));
  }
});

registerHook('ModelUsage', ({ usage, logPrefix }) => {
  formatUsage(usage, logPrefix, verbose).forEach((line, index) => {
    console.log(index === 0 ? chalk.cyan(line) : chalk.gray(line));
  });
});
