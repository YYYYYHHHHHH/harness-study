import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import { registerHook } from './index.js';

registerHook('Stop', async ({ input, messages, client, model, rounds, finished }) => {
  const spinner = ora({ text: chalk.gray('生成本次对话总结...'), spinner: 'dots' }).start();

  const transcript = messages
    .map(m => {
      if (m.role === 'tool') return `[tool result] ${typeof m.content === 'string' ? m.content : ''}`;
      if (m.role === 'assistant') {
        const calls = m.tool_calls?.map(c => c.type === 'function' ? `${c.function.name}(${c.function.arguments})` : '').join(', ');
        return `[assistant] ${m.content ?? ''}${calls ? ` | tool_calls: ${calls}` : ''}`;
      }
      if (m.role === 'user') return `[user] ${typeof m.content === 'string' ? m.content : ''}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: '你是对话总结助手。请用中文简洁总结用户问题、Agent 采取了什么行动、最终结论。用 3-5 个 bullet。不要重复原文。',
        },
        {
          role: 'user',
          content: `用户初始问题：${input}\n\n对话记录：\n${transcript.slice(-6000)}`,
        },
      ],
    });
    spinner.stop();
    const summary = response.choices[0]?.message?.content ?? '(空)';
    console.log(
      boxen(chalk.white(summary), {
        title: chalk.magenta.bold(` 本次对话总结 · ${rounds} 轮 · ${finished ? '正常结束' : '未完成'} `),
        titleAlignment: 'left',
        padding: 1,
        margin: { top: 1, bottom: 1, left: 0, right: 0 },
        borderStyle: 'round',
        borderColor: 'magenta',
      }),
    );
  } catch (error) {
    spinner.fail(chalk.red('总结生成失败'));
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  }
});
