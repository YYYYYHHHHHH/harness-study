import type OpenAI from 'openai';
import { toolsForTeamRole } from './agent-team/capabilities.js';
import type { AgentTeamClient, TeamAgentRole } from './agent-team/types.js';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import ora from 'ora';
import { TokenUsageTracker } from './token-usage.js';
import { ContextCompressor, isContextLengthError } from './context-compression.js';
import { saveContextSnapshot } from './context-snapshots.js';
import { MemoryManager, memoryMessage, injectMemory } from './memory/index.js';
import { hasCompletedBackgroundTasks, takeBackgroundNotifications, type BackgroundTaskMap } from './background-tasks.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { CompletionUsage } from 'openai/resources/completions';
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

export interface AgentOptions {
  client: OpenAI;
  model: string;
  input: string;
  systemPrompt: string;
  tools: AgentTool[];
  skills?: SkillRegistry;
  /** Mutable conversation history shared across user turns; omit for an isolated run. */
  messages?: ChatCompletionMessageParam[];
  /** Defaults to a session-local manager; subagents should explicitly disable memory. */
  memory?: MemoryManager | false;
  logPrefix?: string;
  /** Stable main identity across user turns; subagents receive unique identities. */
  agentId?: string;
  cron?: ToolContext['cron'];
  role?: TeamAgentRole;
  team?: AgentTeamClient;
  /** Defaults to a conversation-local map, reused when messages is reused. */
  bg_task_map?: BackgroundTaskMap;
}

const conversationMemories = new WeakMap<ChatCompletionMessageParam[], MemoryManager>();
const conversationBackgroundTasks = new WeakMap<ChatCompletionMessageParam[], BackgroundTaskMap>();

export interface AgentResult {
  finished: boolean;
  finalContent: string | null;
  rounds: number;
}

export async function runAgent({
  client, model, input, systemPrompt, tools: providedTools, role = 'main', team, skills: providedSkills, messages: history, memory: providedMemory, logPrefix = '', agentId = `agent:${randomUUID()}`, cron, bg_task_map: providedBackgroundTasks,
}: AgentOptions): Promise<AgentResult> {
  const tools = toolsForTeamRole(providedTools, role);
  const directory = process.cwd();
  const usageTracker = new TokenUsageTracker();
  const skills = providedSkills ?? await scanSkills();
  const messages = history ?? [];
  const bg_task_map = providedBackgroundTasks ?? conversationBackgroundTasks.get(messages) ?? new Map();
  conversationBackgroundTasks.set(messages, bg_task_map);
  const context: ToolContext = { client, model, tools, skills, logPrefix, agentId, runId: randomUUID(), cron, bg_task_map, role, team };
  const skillsPrompt = tools.some(tool => tool.schema.function.name === 'load_skill')
    ? buildSkillsPrompt(skills)
    : '';
  const hookContext = { runId: context.runId, logPrefix };
  const tag = logPrefix ? `${logPrefix} ` : '';
  const memory = providedMemory === false ? undefined : providedMemory
    ?? conversationMemories.get(messages) ?? new MemoryManager({ client, model });
  if (memory) conversationMemories.set(messages, memory);
  const turnStart: ChatCompletionMessageParam = { role: 'user', content: input };
  // This transcript only appends originals; compression never receives it.
  const turnTranscript: ChatCompletionMessageParam[] = [structuredClone(turnStart)];
  let loadedMemory: ChatCompletionMessageParam | undefined;
  const onUsage = async (usage: CompletionUsage | undefined) => {
    await triggerModelUsage({ ...hookContext, usage: usageTracker.record(usage) });
  };
  const compressor = new ContextCompressor({
    client, model, runId: context.runId, tools: tools.map(tool => tool.schema),
    turnStart: memory ? turnStart : undefined,
    transientMessages: () => loadedMemory ? [loadedMemory] : [],
    onUsage,
    onEvent: event => console.log(`${tag}[context] ${event}`),
  });
  if (messages.length === 0) messages.push({ role: 'system', content: systemPrompt + skillsPrompt });
  messages.push(turnStart);
  let finished = false;
  let finalContent: string | null = null;
  let rounds = 0;

  try {
    await triggerUserPromptSubmit({ ...hookContext, input });
    if (memory) {
      try { loadedMemory = memoryMessage(await memory.load_memory(input, onUsage)); }
      catch (error) { console.warn(`${tag}[memory] 加载失败，本轮继续：${error instanceof Error ? error.message : String(error)}`); }
    }
    while (true) {
      for (const content of takeBackgroundNotifications(bg_task_map)) {
        const notification: ChatCompletionMessageParam = { role: 'user', content };
        messages.push(notification);
        turnTranscript.push(structuredClone(notification));
      }
      rounds += 1;
      try {
        const spinner = ora({ text: `${tag}${chalk.gray('大模型思考中...')}`, spinner: 'dots' }).start();
        let response;
        try {
          await compressor.prepare(messages);
          while (true) {
            try {
              response = await client.chat.completions.create({
                model,
                messages: injectMemory(messages, turnStart, loadedMemory),
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
        turnTranscript.push(structuredClone(message));
        const toolCalls = message.tool_calls ?? [];
        if (toolCalls.length === 0) {
          // A command may finish while the model is generating its answer.
          if (hasCompletedBackgroundTasks(bg_task_map)) continue;
          finished = true;
          finalContent = message.content ?? '';
          break;
        }

        if (message.content?.trim()) console.log(`${tag}${chalk.gray(message.content)}`);

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
              content = await dispatchTool(toolUse.name, toolUse.argumentsJson, { ...context, toolCallId: toolCall.id });
            } catch (error) {
              ok = false;
              content = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
            }
          }
          await triggerPostToolUse({ ...toolUse, ok, result: content, denied });
          const toolResult: ChatCompletionMessageParam = { role: 'tool', tool_call_id: toolCall.id, content };
          messages.push(toolResult);
          turnTranscript.push(structuredClone(toolResult));
        }
      } finally {
        try {
          await saveContextSnapshot(directory, context.runId, rounds, messages);
        } catch (error) {
          console.warn(`${tag}[context] 第 ${rounds} 轮上下文保存失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (finished && memory) {
      const spinner = ora({ text: `${tag}提取并整理记忆...`, spinner: 'dots' }).start();
      try {
        await memory.finishTurn(turnTranscript, onUsage);
        spinner.stop();
      } catch (error) {
        spinner.stop();
        console.warn(`${tag}[memory] 更新失败，保留已有记忆：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await triggerStop({ ...hookContext, input, messages, client, model, rounds, finished, finalContent });
  }
  return { finished, finalContent, rounds };
}
