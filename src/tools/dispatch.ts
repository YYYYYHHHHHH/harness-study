import { runBash, runRead, runWrite, runEdit, runGlob } from './handlers.js';

function requireString(args: Record<string, unknown>, key: string, toolName: string): string {
  const value = args[key];
  if (typeof value !== 'string') {
    throw new Error(`${toolName} 的 ${key} 参数无效`);
  }
  return value;
}

export async function dispatchTool(name: string, argumentsJson: string): Promise<string> {
  const raw: unknown = JSON.parse(argumentsJson);
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${name} 的参数必须是 JSON 对象`);
  }
  const args = raw as Record<string, unknown>;

  switch (name) {
    case 'bash':
      return runBash(requireString(args, 'command', 'bash'));
    case 'read_file': {
      const path = requireString(args, 'path', 'read_file');
      const limit = args.limit;
      if (limit !== undefined && typeof limit !== 'number') {
        throw new Error('read_file 的 limit 参数必须是数字');
      }
      return runRead(path, limit);
    }
    case 'write_file':
      return runWrite(
        requireString(args, 'path', 'write_file'),
        requireString(args, 'content', 'write_file'),
      );
    case 'edit_file':
      return runEdit(
        requireString(args, 'path', 'edit_file'),
        requireString(args, 'old_text', 'edit_file'),
        requireString(args, 'new_text', 'edit_file'),
      );
    case 'glob':
      return runGlob(requireString(args, 'pattern', 'glob'));
    default:
      throw new Error(`未知工具：${name}`);
  }
}
