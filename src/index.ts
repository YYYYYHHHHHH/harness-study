import OpenAI from 'openai';
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { tools, dispatchTool } from './tools/index.js';
import { checkPermission } from './permissions/index.js';

function truncate(text: string, max = 300): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + chalk.gray(`… (+${text.length - max} chars)`);
}

function summarizeArgs(name: string, argumentsJson: string): string {
  try {
    const args = JSON.parse(argumentsJson) as Record<string, unknown>;
    switch (name) {
      case 'bash':
        return typeof args.command === 'string' ? args.command : '';
      case 'read_file':
      case 'write_file':
      case 'edit_file':
        return typeof args.path === 'string' ? args.path : '';
      case 'glob':
        return typeof args.pattern === 'string' ? args.pattern : '';
      default:
        return '';
    }
  } catch {
    return '';
  }
}

function indent(text: string, prefix = '   │ '): string {
  return text.split('\n').map(line => chalk.gray(prefix) + line).join('\n');
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  const baseURL = process.env.OPENAI_API_BASE_URL;

  if (!apiKey || !model || !baseURL) {
    throw new Error('请在 .env 中填写 OPENAI_API_KEY 和 OPENAI_MODEL');
  }

  const client = new OpenAI({ apiKey, baseURL });

  console.log(
    boxen(
      `${chalk.bold.cyan('✦ Harness Agent')}  ${chalk.gray('v0.1')}\n` +
        `${chalk.gray('模型:')} ${chalk.white(model)}\n` +
        `${chalk.gray('工作区:')} ${chalk.white(process.cwd())}\n\n` +
        `${chalk.gray('提示：')}${chalk.white('回车提交')}${chalk.gray(' · ')}${chalk.white('Ctrl+C 退出')}${chalk.gray(' · 加 --verbose 查看工具详情')}`,
      {
        padding: 1,
        margin: { top: 1, bottom: 0, left: 0, right: 0 },
        borderStyle: 'round',
        borderColor: 'cyan',
        title: chalk.cyan.bold(' 欢迎 '),
        titleAlignment: 'left',
      },
    ),
  );
  console.log(chalk.gray('╭─ ') + chalk.cyan('输入你的问题') + chalk.gray(' ' + '─'.repeat(50)));

  const rl = createInterface({ input: stdin, output: stdout });
  let input: string;
  try {
    process.stdout.write(chalk.gray('│ ') + chalk.cyan.bold('❯ '));
    input = (await new Promise<string>(resolve => rl.once('line', resolve))).trim() || '列出当前目录下的文件';
  } finally {
    rl.close();
  }
  console.log(chalk.gray('╰' + '─'.repeat(60)));

  const systemPrompt = `你是一个在 ${process.cwd()} 工作区的代码智能体。
可用工具：bash（执行 shell 命令）、read_file（读取文件）、write_file（写入文件）、edit_file（替换文件片段）、glob（按模式查找文件）。
请直接采取行动（调用工具），不需要解释。`;

  console.log(chalk.gray('\n用户输入：') + chalk.yellow(input));

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: input },
  ];
  const maxRounds = 10;
  const verbose = process.env.VERBOSE === '1' || process.argv.includes('--verbose');

  for (let round = 0; round < maxRounds; round += 1) {
    console.log(chalk.magenta.bold(`\n━━━ Round ${round + 1} ━━━`));

    const thinkingSpinner = ora({
      text: chalk.gray('模型思考中...'),
      spinner: 'dots',
    }).start();

    let response;
    try {
      response = await client.chat.completions.create({
        model,
        messages,
        tools,
        tool_choice: 'auto',
      });
      thinkingSpinner.stop();
    } catch (error) {
      thinkingSpinner.fail(chalk.red('模型调用失败'));
      throw error;
    }

    const message = response.choices[0]?.message;
    if (!message) {
      throw new Error('模型未返回消息');
    }

    messages.push(message);
    const toolCalls = message.tool_calls ?? [];

    if (toolCalls.length === 0) {
      console.log(
        boxen(chalk.green(message.content ?? ''), {
          title: chalk.green.bold(' 最终答复 '),
          titleAlignment: 'left',
          padding: 1,
          margin: { top: 1, bottom: 1, left: 0, right: 0 },
          borderStyle: 'round',
          borderColor: 'green',
        }),
      );
      return;
    }

    for (const toolCall of toolCalls) {
      if (toolCall.type !== 'function') {
        throw new Error(`不支持的工具调用类型：${toolCall.type}`);
      }
      const fnCall = toolCall.function;
      const summary = summarizeArgs(fnCall.name, fnCall.arguments);

      const toolSpinner = ora({
        text: `${chalk.blue('调用工具')} ${chalk.cyan.bold(fnCall.name)}${summary ? chalk.gray(` — ${truncate(summary, 60)}`) : ''}`,
        spinner: 'dots',
      }).start();

      let content: string;
      let ok = true;
      const permission = await checkPermission(fnCall.name, fnCall.arguments);
      if (!permission.allowed) {
        ok = false;
        content = permission.reason;
      } else {
        try {
          content = await dispatchTool(fnCall.name, fnCall.arguments);
        } catch (error) {
          ok = false;
          content = JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const statusText = `${chalk.cyan.bold(fnCall.name)}${summary ? chalk.gray(` — ${truncate(summary, 60)}`) : ''}`;
      if (ok) {
        toolSpinner.succeed(`${chalk.green('工具完成')} ${statusText}`);
      } else {
        toolSpinner.fail(`${chalk.red('工具失败')} ${statusText}`);
      }

      if (verbose) {
        console.log(indent(chalk.gray(`args = ${truncate(fnCall.arguments, 400)}`)));
        console.log(indent(chalk.gray(`result = ${truncate(content, 800)}`)));
      } else {
        console.log(chalk.gray(`   └ 展开详情请加 --verbose 或设 VERBOSE=1`));
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content,
      });
    }
  }

  throw new Error(`Agent Loop 超过最大轮次 ${maxRounds}`);
}

main().catch(error => {
  console.error(chalk.red.bold('✗ '), chalk.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
