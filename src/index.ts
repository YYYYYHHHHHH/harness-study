import OpenAI from 'openai';
import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { tools, dispatchTool } from './tools/index.js';
import {
  triggerUserPromptSubmit,
  triggerPreToolUse,
  triggerPostToolUse,
  triggerStop,
} from './hooks/index.js';
import './hooks/logging.js';
import './hooks/permission.js';
import './hooks/summarize.js';

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
可用工具：todo_write（写入/更新 TODO 计划）、bash（执行 shell 命令）、read_file（读取文件）、write_file（写入文件）、edit_file（替换文件片段）、glob（按模式查找文件）。

重要规则：
1. 在执行任何其他工具之前，你必须先调用一次 todo_write 把要做的事情拆解成有序任务（status 用「未开始」「进行中」「已完成」三种之一），把即将执行的第一个任务标记为「进行中」。
2. 每完成一个任务后，再次调用 todo_write 更新状态：把刚完成的任务改为「已完成」，并把下一个要做的任务置为「进行中」。
3. 同一时间最多只能有一个任务处于「进行中」。
4. 规划完成后直接采取行动（调用工具），不需要额外解释。`;

  await triggerUserPromptSubmit({ input });

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: input },
  ];
  const maxRounds = 10;
  let finished = false;
  let finalContent: string | null = null;
  let round = 0;

  try {
    for (; round < maxRounds; round += 1) {
      console.log(chalk.magenta.bold(`\n━━━ Round ${round + 1} ━━━`));

      const modelSpinner = ora({
        text: chalk.gray('大模型思考中...'),
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
        modelSpinner.stop();
      } catch (error) {
        modelSpinner.fail(chalk.red('大模型调用失败'));
        throw error;
      }
      const message = response.choices[0]?.message;
      if (!message) {
        throw new Error('模型未返回消息');
      }
      messages.push(message);

      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        finished = true;
        finalContent = message.content ?? '';
        console.log(
          boxen(chalk.green(finalContent), {
            title: chalk.green.bold(' 最终答复 '),
            titleAlignment: 'left',
            padding: 1,
            margin: { top: 1, bottom: 1, left: 0, right: 0 },
            borderStyle: 'round',
            borderColor: 'green',
          }),
        );
        break;
      }

      for (const toolCall of toolCalls) {
        if (toolCall.type !== 'function') {
          throw new Error(`不支持的工具调用类型：${toolCall.type}`);
        }
        const fnCall = toolCall.function;

        const decision = await triggerPreToolUse({
          name: fnCall.name,
          argumentsJson: fnCall.arguments,
          toolCallId: toolCall.id,
        });

        let content: string;
        let ok = true;
        let denied = false;
        if (decision && decision.deny) {
          ok = false;
          denied = true;
          content = decision.reason;
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

        await triggerPostToolUse({
          name: fnCall.name,
          argumentsJson: fnCall.arguments,
          toolCallId: toolCall.id,
          ok,
          result: content,
          denied,
        });

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content,
        });
      }
    }
  } finally {
    await triggerStop({
      input,
      messages,
      client,
      model,
      rounds: round + (finished ? 0 : 1),
      finished,
      finalContent,
    });
  }

  if (!finished) {
    throw new Error(`Agent Loop 超过最大轮次 ${maxRounds}`);
  }
}

main().catch(error => {
  console.error(chalk.red.bold('✗ '), chalk.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
