import type { AgentTool } from '../tools/dispatch.js';
import type { TeamAgentRole } from './types.js';

export const TEAMMATE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'bash', 'read_file', 'write_file', 'edit_file', 'glob', 'load_skill', 'todo_write', 'send_message',
]);

/** Apply before both advertising schemas and constructing the dispatcher context. */
export function toolsForTeamRole(tools: readonly AgentTool[], role: TeamAgentRole): AgentTool[] {
  if (role === 'main') return [...tools];
  if (role === 'teammate') return tools.filter(tool => TEAMMATE_TOOL_NAMES.has(tool.schema.function.name));
  // Preserve legacy tools, but do not inherit the new team client/management tools.
  return tools.filter(tool => !['spawn_subagent', 'spawn_teammates', 'send_message'].includes(tool.schema.function.name));
}
