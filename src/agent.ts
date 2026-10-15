import type OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import ora from 'ora';
import { TokenUsageTracker } from './token-usage.js';
import { ContextCompressor, isContextLengthError } from './context-compression.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { dispatchTool, type AgentTool, type ToolContext } from './tools/dispatch.js';
import { scanSkills, buildSkillsPrompt, type SkillRegistry } from './skills/index.js';
import {
  triggerUserPromptSubmit,
  triggerPreToolUse,
  triggerPostToolUse,
  triggerStop,
  triggerModelUsage,
} from './hooks/index.js';
import './hooks/logging.js';
import './hooks/permission.js';
import './hooks/summarize.js';

export interface AgentOptions {
  client: OpenAI;
  model: string;
  input: string;
  systemPrompt: string;
  tools: AgentTool[];
  skills?: SkillRegistry;
  logPrefix?: string;
}

export interface AgentResult {
  finished: boolean;
  finalContent: string | null;
  rounds: number;
}

export async function runAgent({
  client, model, input, systemPrompt, tools, skills: providedSkills, logPrefix = '',
}: AgentOptions): Promise<AgentResult> {
  const usageTracker = new TokenUsageTracker();
  const skills = providedSkills ?? await scanSkills();
  const context: ToolContext = { client, model, tools, skills, logPrefix, runId: randomUUID() };
  const skillsPrompt = tools.some(tool => tool.schema.function.name === 'load_skill')
    ? buildSkillsPrompt(skills)
    : '';
  const hookContext = { runId: context.runId, logPrefix };
  const tag = logPrefix ? `${logPrefix} ` : '';
  const compressor = new ContextCompressor({
    client, model, runId: context.runId, tools: tools.map(tool => tool.schema),
    onUsage: async usage => {
      await triggerModelUsage({ ...hookContext, usage: usageTracker.record(usage) });
    },
    onEvent: event => console.log(`${tag}[context] ${event}`),
  });
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt + skillsPrompt },
    { role: 'user', content: input },
  ];
  let finished = false;
  let finalContent: string | null = null;
  let rounds = 0;

  try {
    await triggerUserPromptSubmit({ ...hookContext, input });
    while (true) {
      rounds += 1;
      console.log(`\n${tag}${chalk.magenta.bold(`━━━ Round ${rounds} ━━━`)}`);
      const spinner = ora({ text: `${tag}${chalk.gray('大模型思考中...')}`, spinner: 'dots' }).start();
      let response;
      try {
        await compressor.prepare(messages);
        while (true) {
          try {
            response = await client.chat.completions.create({
              model,
              messages: [...messages],
              max_completion_tokens: compressor.maxOutput,
              ...(tools.length ? { tools: tools.map(tool => tool.schema), tool_choice: 'auto' as const } : {}),
            });
            break;
          } catch (error) {
            if (!isContextLengthError(error)) throw error;
            await compressor.recover(messages);
          }
        }
        spinner.stop();
      } catch (error) {
        spinner.fail(`${tag}${chalk.red('大模型调用失败')}`);
        throw error;
      }
      await triggerModelUsage({ ...hookContext, usage: usageTracker.record(response.usage) });
      const message = response.choices[0]?.message;
      if (!message) throw new Error('模型未返回消息');
      messages.push(message);
      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        finished = true;
        finalContent = message.content ?? '';
        break;
      }

      for (const toolCall of toolCalls) {
        if (toolCall.type !== 'function') {
          throw new Error(`不支持的工具调用类型：${toolCall.type}`);
        }
        const toolUse = {
          ...hookContext,
          name: toolCall.function.name,
          argumentsJson: toolCall.function.arguments,
          toolCallId: toolCall.id,
        };
        const decision = await triggerPreToolUse(toolUse);
        let content: string;
        let ok = true;
        let denied = false;
        if (decision?.deny) {
          ok = false;
          denied = true;
          content = decision.reason;
        } else {
          try {
            content = await dispatchTool(toolUse.name, toolUse.argumentsJson, context);
          } catch (error) {
            ok = false;
            content = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
          }
        }
        await triggerPostToolUse({ ...toolUse, ok, result: content, denied });
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content });
      }
    }
  } finally {
    await triggerStop({ ...hookContext, input, messages, client, model, rounds, finished, finalContent });
  }
  return { finished, finalContent, rounds };
}
