import { checkPermission } from '../permissions/index.js';
import { registerHook } from './index.js';

registerHook('PreToolUse', async ({ name, argumentsJson }) => {
  const permission = await checkPermission(name, argumentsJson);
  if (!permission.allowed) {
    return { deny: true, reason: permission.reason };
  }
});
