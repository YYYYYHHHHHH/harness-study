import OpenAI from 'openai';
import chalk from 'chalk';
import boxen from 'boxen';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { tools } from './tools/index.js';
import { runAgent } from './agent.js';

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  const baseURL = process.env.OPENAI_API_BASE_URL;

  if (!apiKey || !model || !baseURL) {
    throw new Error('请在 .env 中填写 OPENAI_API_KEY / OPENAI_MODEL / OPENAI_API_BASE_URL');
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

  const systemPrompt = `你是一个在 ${process.cwd()} 工作区的代码智能体（主 agent）。
可用工具：todo_write（写入/更新 TODO 计划）、bash、read_file、write_file、edit_file、glob、spawn_subagent（派发子任务给独立 subagent，返回它的总结）、load_skill（按名称加载 skill 完整正文）。

重要规则：
1. 在执行任何其他工具之前，你必须先调用一次 todo_write 把要做的事情拆解成有序任务（status 用「未开始」「进行中」「已完成」三种之一），把即将执行的第一个任务标记为「进行中」。
2. 每完成一个任务后，再次调用 todo_write 更新状态：把刚完成的任务改为「已完成」，并把下一个要做的任务置为「进行中」。
3. 同一时间最多只能有一个任务处于「进行中」。
4. 当某个子任务相对独立、可一次性交付结果（例如大段代码搜索、独立调研、隔离的实现），可以使用 spawn_subagent 派发；派发时要在 task 字段里给出完整上下文与期望产出，subagent 返回的字符串就是最终结果。
5. 规划完成后直接采取行动（调用工具），不需要额外解释。`;

  const result = await runAgent({ client, model, input, systemPrompt, tools });
  if (!result.finished) {
    throw new Error(`Agent Loop 超过最大轮次 ${result.rounds}`);
  }
  console.log(
    boxen(chalk.green(result.finalContent ?? ''), {
      title: chalk.green.bold(' 最终答复 '),
      titleAlignment: 'left',
      padding: 1,
      margin: { top: 1, bottom: 1, left: 0, right: 0 },
      borderStyle: 'round',
      borderColor: 'green',
    }),
  );
}

main().catch(error => {
  console.error(chalk.red.bold('✗ '), chalk.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
