import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

export interface UserPromptSubmitCtx {
  input: string;
}

export interface PreToolUseCtx {
  name: string;
  argumentsJson: string;
  toolCallId: string;
}

export interface PostToolUseCtx {
  name: string;
  argumentsJson: string;
  toolCallId: string;
  ok: boolean;
  result: string;
  denied: boolean;
}

export interface StopCtx {
  input: string;
  messages: ChatCompletionMessageParam[];
  client: OpenAI;
  model: string;
  rounds: number;
  finished: boolean;
  finalContent: string | null;
}

export type PreToolUseDecision = void | { deny: true; reason: string };

export type UserPromptSubmitHook = (ctx: UserPromptSubmitCtx) => void | Promise<void>;
export type PreToolUseHook = (ctx: PreToolUseCtx) => PreToolUseDecision | Promise<PreToolUseDecision>;
export type PostToolUseHook = (ctx: PostToolUseCtx) => void | Promise<void>;
export type StopHook = (ctx: StopCtx) => void | Promise<void>;

interface Registry {
  UserPromptSubmit: UserPromptSubmitHook[];
  PreToolUse: PreToolUseHook[];
  PostToolUse: PostToolUseHook[];
  Stop: StopHook[];
}

const registry: Registry = {
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};

export function registerHook(kind: 'UserPromptSubmit', hook: UserPromptSubmitHook): void;
export function registerHook(kind: 'PreToolUse', hook: PreToolUseHook): void;
export function registerHook(kind: 'PostToolUse', hook: PostToolUseHook): void;
export function registerHook(kind: 'Stop', hook: StopHook): void;
export function registerHook(kind: keyof Registry, hook: unknown): void {
  (registry[kind] as unknown[]).push(hook);
}

export async function triggerUserPromptSubmit(ctx: UserPromptSubmitCtx): Promise<void> {
  for (const hook of registry.UserPromptSubmit) {
    await hook(ctx);
  }
}

export async function triggerPreToolUse(ctx: PreToolUseCtx): Promise<PreToolUseDecision> {
  for (const hook of registry.PreToolUse) {
    const decision = await hook(ctx);
    if (decision && decision.deny) {
      return decision;
    }
  }
}

export async function triggerPostToolUse(ctx: PostToolUseCtx): Promise<void> {
  for (const hook of registry.PostToolUse) {
    await hook(ctx);
  }
}

export async function triggerStop(ctx: StopCtx): Promise<void> {
  for (const hook of registry.Stop) {
    await hook(ctx);
  }
}
