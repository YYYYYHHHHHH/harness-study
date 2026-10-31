import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { AgentTurns } from '../agent-turns.js';
import type { BackgroundTaskMap } from '../background-tasks.js';
import type { SpawnTeammatesArgs, SendMessageArgs, TeamMessage } from './protocol.js';

export type TeamAgentRole = 'main' | 'teammate' | 'subagent';
export type TeamAgentState = 'idle' | 'running' | 'stopping' | 'stopped';

export interface TeamAgentError {
  phase: 'startup' | 'model' | 'storage';
  message: string;
  created_at: string;
  /** Present if failure occurred while consuming a message. */
  messageId?: string;
}

export interface TeamAgentStatus {
  name: string;
  agentId: string;
  state: TeamAgentState;
  /** Retained and observable after stopping. Never used to trigger automatic retry. */
  error?: TeamAgentError;
}

/** Each teammate owns these objects for its entire session; none alias main's. */
export interface TeammateSession extends TeamAgentStatus {
  role: 'teammate';
  prompt: string;
  messages: ChatCompletionMessageParam[];
  bg_task_map: BackgroundTaskMap;
  turns: AgentTurns;
  memory: false;
}

/** Construct once per authenticated agent; identity and role are bound by runtime. */
export interface AgentTeamClient {
  /** Main only. Resolve after batch reservation/startup, not after teammates finish. */
  spawnTeammates(args: SpawnTeammatesArgs): Promise<{ teammates: TeamAgentStatus[] }>;
  /** Resolve after durable append, not after consumption or a response. */
  sendMessage(args: SendMessageArgs): Promise<TeamMessage>;
}

/** A single owner per workspace; implementations serialize append/peek/ack per inbox. */
export interface TeamMessageBus {
  /** Allocate id/time internally; authenticate using a runtime-bound client first. */
  append(args: SendMessageArgs): Promise<TeamMessage>;
  /** Reserve the FIFO head for the sole consumer, leaving its durable record intact. */
  peek(target: string): Promise<TeamMessage | undefined>;
  /** Remove only this head after successful runAgent completion; preserve later appends. */
  acknowledge(target: string, messageId: string): Promise<void>;
}

export interface AgentTeamLifecycle {
  status(): readonly TeamAgentStatus[];
  /** Cancel timers/admission, await active loops; never clear inboxes or silently retry. */
  stop(): Promise<void>;
}
