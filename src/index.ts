import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import chalk from 'chalk';
import boxen from 'boxen';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { tools } from './tools/index.js';
import { runAgent } from './agent.js';
import { scanSkills } from './skills/index.js';
import { completeSkillReference, formatSkillList, readSkillInputs } from './cli/skill-slash.js';
import { AgentTurns } from './agent-turns.js';
import { CronScheduler } from './cron/service.js';
import { CronConsumer } from './cron/consumer.js';

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
        `${chalk.gray('提示：')}${chalk.white('回车提交')}${chalk.gray(' · ')}${chalk.white('/ 列出 skills · Tab 补全')}${chalk.gray(' · ')}${chalk.white('Ctrl+C 退出')}${chalk.gray(' · 加 --verbose 查看工具详情')}`,
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

  const skills = await scanSkills();
  const cron = await CronScheduler.start();
  const rl = createInterface({
    input: stdin,
    output: stdout,
    completer: line => completeSkillReference(line, skills),
  });
  rl.setPrompt(chalk.gray('│ ') + chalk.cyan.bold('❯ '));
  // readline processes keypresses first; display hints without changing its buffer.
  // Non-TTY input still supports a standalone '/' line followed by the question.
  const showSlashHints = (_text: string, key: { sequence?: string }) => {
    if (key.sequence === '/' && completeSkillReference(rl.line.slice(0, rl.cursor), skills)[1] === '/') {
      stdout.write('\n' + chalk.cyan(formatSkillList(skills)) + '\n');
      rl.prompt(true);
    }
  };
  if (stdin.isTTY && stdout.isTTY) stdin.on('keypress', showSlashHints);
  const systemPrompt = `你是一个在 ${process.cwd()} 工作区的代码智能体（主 agent）。
可用工具：todo_write（写入/更新 TODO 计划）、bash、read_file、write_file、edit_file、glob、spawn_subagent（派发子任务给独立 subagent，返回它的总结）、load_skill（按名称加载 skill 完整正文）、create_tasks、clamic_task、get_tasks_detail、complate_tasks（持久化任务系统）、create_cron_job、cancel_cron_job、list_cron_job（定时调度系统）。
定时任务通过 prompt 描述执行内容，drauble=true 表示持久化，recurring=true 表示重复执行、false 表示一次性。cron 使用本地时区，支持五字段或首位为秒的六字段表达式。定时任务到期后在主 agent 空闲时执行。

重要规则：
1. 在执行任何其他工具之前，你必须先调用一次 todo_write 把要做的事情拆解成有序任务（status 用「未开始」「进行中」「已完成」三种之一），把即将执行的第一个任务标记为「进行中」。
2. 每完成一个任务后，再次调用 todo_write 更新状态：把刚完成的任务改为「已完成」，并把下一个要做的任务置为「进行中」。
3. 同一时间最多只能有一个任务处于「进行中」。
4. 当某个子任务相对独立、可一次性交付结果（例如大段代码搜索、独立调研、隔离的实现），可以使用 spawn_subagent 派发；派发时要在 task 字段里给出完整上下文与期望产出，subagent 返回的字符串就是最终结果。
5. 多步骤或跨会话任务使用持久化任务工具：先 get_tasks_detail 查看已有任务，再 create_tasks 建立依赖任务；执行前 clamic_task 领取，成功后 complate_tasks 完成。新任务通常用 wait 状态；owner 自动来自当前 agent，不得伪造。保留 todo_write 用于当前回合展示。
6. 规划完成后直接采取行动（调用工具），不需要额外解释。`;

  const agentId = `main:${randomUUID()}`;
  const messages: ChatCompletionMessageParam[] = [];
  const turns = new AgentTurns();
  const execute = async (input: string) => {
    const result = await runAgent({ client, model, input, systemPrompt, tools, skills, messages, agentId, cron });
    if (!result.finished) throw new Error(`Agent 未完成任务（已执行 ${result.rounds} 轮）`);
    console.log(
      boxen(chalk.green(result.finalContent ?? ''), {
        title: chalk.green.bold(' 答复 '), titleAlignment: 'left', padding: 1,
        margin: { top: 1, bottom: 1, left: 0, right: 0 }, borderStyle: 'round', borderColor: 'green',
      }),
    );
  };
  let closed = false;
  const consumer = new CronConsumer(cron, turns, async job => {
    console.log(chalk.cyan(`\n[cron:${job.id}] ${job.prompt}`));
    try { await execute(job.prompt); }
    finally { if (!closed) rl.prompt(true); }
  }, error => console.error(chalk.red(`[cron] ${error instanceof Error ? error.message : String(error)}`)));
  const shutdown = () => rl.close();
  rl.on('SIGINT', shutdown);
  rl.on('close', () => { closed = true; void consumer.stop(); });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  consumer.start();
  try {
    for await (const input of readSkillInputs(rl, skills, {
      prompt: () => rl.prompt(),
      list: text => console.log(chalk.cyan(text)),
      unknown: names => console.warn(chalk.yellow(
        `未找到 skill：${names.map(name => `/${name}`).join('、')}；已保留原始引用并继续提交。输入 / 可查看可用 skills。`,
      )),
    })) {
      await turns.run(() => execute(input));
    }
  } finally {
    stdin.off('keypress', showSlashHints);
    rl.close();
    try { await consumer.stop(); }
    finally {
      try { await cron.stop(); }
      finally {
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
      }
    }
  }
}

main().catch(error => {
  console.error(chalk.red.bold('✗ '), chalk.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
