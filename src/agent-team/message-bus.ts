import { randomUUID } from 'node:crypto';
import { InboxError, InboxStore } from './inbox.js';
import { parseAgentName, parseSendMessageArgs, type SendMessageArgs, type TeamMessage } from './protocol.js';
import type { TeamMessageBus } from './types.js';

/** One owner per workspace. All read/modify/write operations share this mutex. */
export class MessageBus implements TeamMessageBus {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly agents = new Set<string>();
  private readonly reservations = new Map<string, string>();
  private readonly failures = new Map<string, InboxError>();
  private storageFailure?: InboxError;
  private closing = false;
  private closePromise?: Promise<void>;

  private constructor(private readonly store: InboxStore) {}

  static async open(workspace: string): Promise<MessageBus> {
    return new MessageBus(await InboxStore.open(workspace));
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new InboxError('CLOSED', 'Message bus is closing or closed', this.store.root));
    const result = this.queue.then(() => {
      if (this.storageFailure) throw this.storageFailure;
      return operation();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  private async storage<T>(target: string, operation: () => Promise<T>, messageId?: string): Promise<T> {
    try { return await operation(); }
    catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.storageFailure = new InboxError('STORAGE', `Inbox I/O or integrity failure; all bus operations stopped; inspect before reopening: ${detail}`, this.store.path(target), messageId, { cause });
      throw this.storageFailure;
    }
  }

  private accepting(target: string): void {
    parseAgentName(target);
    if (!this.agents.has(target)) throw new InboxError('UNREGISTERED', 'Agent is not registered', this.store.path(target));
    const failure = this.failures.get(target);
    if (failure) throw failure;
  }

  /** Explicit recovery is a human/runtime decision, never a polling fallback. */
  register(target: string, options: { recover?: boolean } = {}): Promise<void> {
    const recover = options.recover === true;
    return this.exclusive(async () => {
      parseAgentName(target);
      if (this.agents.has(target)) throw new InboxError('REGISTERED', 'Agent is already registered', this.store.path(target));
      const messages = await this.storage(target, () => this.store.register(target));
      if (messages.length && !recover) {
        throw new InboxError('RECOVERY_REQUIRED', 'Nonempty inbox preserved; explicit recovery required', this.store.path(target), messages[0].id);
      }
      this.agents.add(target);
    });
  }

  /** Trusted runtime API; a runtime-bound client must authenticate sender first. */
  append(args: SendMessageArgs): Promise<TeamMessage> {
    // Snapshot caller-owned data before asynchronous admission.
    const input = { ...args };
    return this.exclusive(async () => {
      const parsed = parseSendMessageArgs(input, { agentName: input.sender, knownAgents: this.agents });
      this.accepting(parsed.sender);
      this.accepting(parsed.target);
      const message: TeamMessage = { ...parsed, id: randomUUID(), created_at: new Date().toISOString() };
      await this.storage(parsed.target, async () => {
        const messages = await this.store.read(parsed.target);
        await this.store.replace(parsed.target, [...messages, message]);
      }, message.id);
      return message;
    });
  }

  /** Reserve one head. A second consumer is rejected until ack or shutdown. */
  peek(target: string): Promise<TeamMessage | undefined> {
    return this.exclusive(async () => {
      this.accepting(target);
      const reserved = this.reservations.get(target);
      if (reserved) throw new InboxError('RESERVED', 'Inbox already has an in-flight consumer', this.store.path(target), reserved);
      const messages = await this.storage(target, () => this.store.read(target));
      const message = messages[0];
      if (message) this.reservations.set(target, message.id);
      return message;
    });
  }

  acknowledge(target: string, messageId: string): Promise<void> {
    return this.exclusive(async () => {
      this.accepting(target);
      if (!this.reservations.has(target) || this.reservations.get(target) !== messageId) {
        throw new InboxError('RESERVATION_MISMATCH', 'Ack must match the reserved head', this.store.path(target), messageId);
      }
      await this.storage(target, async () => {
        const messages = await this.store.read(target);
        if (messages[0]?.id !== messageId) {
          throw new InboxError('HEAD_CHANGED', 'Reserved head changed; inbox preserved', this.store.path(target), messageId);
        }
        await this.store.replace(target, messages.slice(1));
      }, messageId);
      this.reservations.delete(target);
    });
  }

  /** Call on runAgent failure/finished:false. Retains head and disables this route. */
  fail(target: string, messageId: string, cause: unknown): Promise<void> {
    return this.exclusive(async () => {
      this.accepting(target);
      if (!this.reservations.has(target) || this.reservations.get(target) !== messageId) {
        throw new InboxError('RESERVATION_MISMATCH', 'Failure must match the reserved head', this.store.path(target), messageId);
      }
      this.failures.set(target, new InboxError('CONSUMER_FAILED', 'Consumer failed; message retained and route stopped', this.store.path(target), messageId, { cause }));
    });
  }

  /** Observable even after close; lifecycle owners must also record/log errors. */
  error(target: string): InboxError | undefined {
    parseAgentName(target);
    return this.storageFailure ?? this.failures.get(target);
  }

  /** Stop admission, finish admitted I/O, release ownership. Never clears inboxes. */
  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.closePromise = this.queue.then(() => this.store.close());
    }
    return this.closePromise;
  }
}
