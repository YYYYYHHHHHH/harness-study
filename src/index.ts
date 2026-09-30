import OpenAI from 'openai';
import chalk from 'chalk';
import boxen from 'boxen';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { tools, dispatchTool } from './tools/index.js';
import { checkPermission } from './permissions/index.js';

function truncate(text: string, max = 300): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + chalk.gray(`… (+${text.length - max} chars)`);
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  const baseURL = process.env.OPENAI_API_BASE_URL;

  if (!apiKey || !model || !baseURL) {
    throw new Error('请在 .env 中填写 OPENAI_API_KEY 和 OPENAI_MODEL');
  }

  const client = new OpenAI({ apiKey, baseURL });

  const rl = createInterface({ input: stdin, output: stdout });
  let input: string;
  try {
    const answer = await rl.question(chalk.cyan.bold('请输入你的问题: '));
    input = answer.trim() || '列出当前目录下的文件';
  } finally {
    rl.close();
  }

  const systemPrompt = `你是一个在 ${process.cwd()} 工作区的代码智能体。
可用工具：bash（执行 shell 命令）、read_file（读取文件）、write_file（写入文件）、edit_file（替换文件片段）、glob（按模式查找文件）。
请直接采取行动（调用工具），不需要解释。`;

  console.log(
    boxen(
      `${chalk.bold.cyan('Agent 启动')}\n` +
        `${chalk.gray('模型:')} ${chalk.white(model)}\n` +
        `${chalk.gray('工作目录:')} ${chalk.white(process.cwd())}\n` +
        `${chalk.gray('用户输入:')} ${chalk.yellow(input)}`,
      {
        padding: 1,
        margin: { top: 1, bottom: 1, left: 0, right: 0 },
        borderStyle: 'round',
        borderColor: 'cyan',
      },
    ),
  );

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: input },
  ];
  const maxRounds = 10;

  for (let round = 0; round < maxRounds; round += 1) {
    console.log(chalk.magenta.bold(`\n━━━ Round ${round + 1} ━━━`));

    const response = await client.chat.completions.create({
      model,
      messages,
      tools,
      tool_choice: 'auto',
    });
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

      console.log(
        `${chalk.blue.bold('◆ Tool')} ${chalk.cyan(fnCall.name)} ` +
          chalk.gray(`args=${truncate(fnCall.arguments, 200)}`),
      );
      console.log(
        `  ${ok ? chalk.green('✓ result') : chalk.red('✗ error')} ` +
          chalk.gray(truncate(content, 500)),
      );

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
