import type { ToolHandler } from './dispatch.js';
import { parseSpawnTeammatesArgs } from '../agent-team/protocol.js';

export const teamHandlers: Record<string, ToolHandler> = {
  spawn_teammates: async (args, context) => {
    if ((context.role ?? 'main') !== 'main') throw new Error('只有 main 可以创建 teammate');
    if (!context.team) throw new Error('团队运行时未启用');
    return JSON.stringify(await context.team.spawnTeammates(parseSpawnTeammatesArgs(args)));
  },
  send_message: async (args, context) => {
    if (!context.team) throw new Error('团队运行时未启用');
    // The bound client validates every field, sender identity and live recipients.
    return JSON.stringify(await context.team.sendMessage(args as unknown as Parameters<typeof context.team.sendMessage>[0]));
  },
};
