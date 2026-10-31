import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { decodeInboxMessage, encodeInboxMessage, INBOX_DIRECTORY, parseAgentName, type TeamMessage } from './protocol.js';

export class InboxError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly path: string,
    public readonly messageId?: string,
    options?: ErrorOptions,
  ) {
    super(`${message} [${path}]${messageId ? ` (messageId=${messageId})` : ''}`, options);
    this.name = 'InboxError';
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

type Identity = { dev: number; ino: number };
const sameFile = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;

async function syncDirectory(path: string): Promise<void> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Internal storage. Only MessageBus calls this, under its single I/O mutex. */
export class InboxStore {
  private constructor(
    readonly root: string,
    private readonly rootIdentity: Identity,
    private readonly lockIdentity: Identity,
  ) {}

  static async open(workspace: string): Promise<InboxStore> {
    // Canonicalize the workspace (e.g. macOS /tmp), but never follow an inbox symlink.
    const canonicalWorkspace = await fs.realpath(workspace);
    const root = join(canonicalWorkspace, INBOX_DIRECTORY);
    try {
      await fs.mkdir(root, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new InboxError('UNSAFE_PATH', 'Inbox root must be a real directory', root);
    }
    // Persist the root's directory entry as well as subsequent inbox entries.
    await syncDirectory(canonicalWorkspace);
    const lock = join(root, '.owner.lock');
    try {
      await fs.mkdir(lock, { mode: 0o700 });
    } catch (error) {
      throw new InboxError('OWNERSHIP', 'Cannot acquire inbox ownership; another bus or stale lock exists. Stop all owners before manual recovery', lock, undefined, { cause: error });
    }
    return new InboxStore(root, stat, await fs.lstat(lock));
  }

  path(target: string): string {
    return join(this.root, `${parseAgentName(target)}.jsonl`);
  }

  async assertOwnership(): Promise<void> {
    const root = await fs.lstat(this.root);
    const lockPath = join(this.root, '.owner.lock');
    if (!root.isDirectory() || !sameFile(root, this.rootIdentity)) {
      throw new InboxError('UNSAFE_PATH', 'Inbox root changed', this.root);
    }
    const lock = await fs.lstat(lockPath);
    if (!lock.isDirectory() || !sameFile(lock, this.lockIdentity)) {
      throw new InboxError('OWNERSHIP', 'Inbox ownership lock changed', lockPath);
    }
  }

  private async regularFile(path: string): Promise<Identity> {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new InboxError('UNSAFE_PATH', 'Inbox must be a regular file without symlinks or hard links', path);
    }
    return stat;
  }

  async register(target: string): Promise<TeamMessage[]> {
    await this.assertOwnership();
    const path = this.path(target);
    try {
      await fs.lstat(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const handle = await fs.open(path, 'wx', 0o600);
      try { await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(this.root);
    }
    return this.read(target);
  }

  async read(target: string): Promise<TeamMessage[]> {
    await this.assertOwnership();
    const path = this.path(target);
    const identity = await this.regularFile(path);
    const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || !sameFile(stat, identity)) {
        throw new InboxError('UNSAFE_PATH', 'Inbox changed while opening', path);
      }
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch (error) { throw new InboxError('CORRUPT', 'Invalid UTF-8; inbox preserved', path, undefined, { cause: error }); }
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const ids = new Set<string>();
    return lines.map((line, index) => {
      try {
        const message = decodeInboxMessage(line);
        if (message.target !== target) throw new Error(`Target mismatch: ${message.target}`);
        if (ids.has(message.id)) throw new Error(`Duplicate message id: ${message.id}`);
        ids.add(message.id);
        return message;
      } catch (error) {
        throw new InboxError('CORRUPT', `Invalid inbox line ${index + 1}; inbox preserved`, path, undefined, { cause: error });
      }
    });
  }

  async replace(target: string, messages: readonly TeamMessage[]): Promise<void> {
    const path = this.path(target);
    const temporary = join(this.root, `.pending-${randomUUID()}`);
    const content = messages.map(encodeInboxMessage).join('');
    await this.assertOwnership();
    await this.regularFile(path);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      await this.assertOwnership();
      await this.regularFile(path);
      await fs.rename(temporary, path);
      // A failure here is an uncertain commit: never automatically retry it.
      await syncDirectory(this.root);
    } finally {
      await fs.unlink(temporary).catch(error => { if (!isMissing(error)) throw error; });
    }
  }

  async close(): Promise<void> {
    await this.assertOwnership();
    await fs.rmdir(join(this.root, '.owner.lock'));
  }
}
