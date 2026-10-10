import type OpenAI from 'openai';
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import type { SkillRegistry } from '../skills/index.js';

export interface ToolContext {
  client: OpenAI;
  model: string;
  tools: AgentTool[];
  skills: SkillRegistry;
  logPrefix: string;
  runId: string;
}

export type ToolHandler = (args: Record<string, unknown>, context: ToolContext) => Promise<string>;

export interface AgentTool {
  schema: ChatCompletionFunctionTool;
  handler: ToolHandler;
}

export async function dispatchTool(name: string, argumentsJson: string, context: ToolContext): Promise<string> {
  const tool = context.tools.find(tool => tool.schema.function.name === name);
  if (!tool) throw new Error(`当前 agent 未启用工具：${name}`);
  const raw: unknown = JSON.parse(argumentsJson);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${name} 的参数必须是 JSON 对象`);
  }
  return tool.handler(raw as Record<string, unknown>, context);
}
