import { toolSchemas } from './schemas.js';
import { toolHandlers } from './handlers.js';
import type { AgentTool } from './dispatch.js';

export const tools: AgentTool[] = toolSchemas.map(schema => {
  const handler = toolHandlers[schema.function.name];
  if (!handler) throw new Error(`工具缺少 handler：${schema.function.name}`);
  return { schema, handler };
});
