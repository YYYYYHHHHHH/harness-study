import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/** Save the current context, before a later loop can compress or append to it. */
export async function saveContextSnapshot(
  directory: string, runId: string, round: number, messages: readonly ChatCompletionMessageParam[],
): Promise<void> {
  const content = JSON.stringify(messages, null, 2) + '\n';
  const folder = resolve(directory, '.context', 'messages', runId);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(resolve(folder, `round-${String(round).padStart(4, '0')}.json`), content, {
    encoding: 'utf8', flag: 'wx', mode: 0o600,
  });
}
