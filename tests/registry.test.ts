import { afterEach, expect, it, vi } from 'vitest';

// Avoid importing the real agent and its hooks while testing registration.
vi.mock('../src/agent.js', () => ({ runAgent: vi.fn() }));
import { tools } from '../src/tools/index.js';
import { toolSchemas } from '../src/tools/schemas.js';
import { toolHandlers } from '../src/tools/handlers.js';
import { toolsForTeamRole } from '../src/agent-team/capabilities.js';

afterEach(() => {
  vi.doUnmock('../src/tools/handlers.js');
  vi.resetModules();
});

it('registers every schema with the matching handler, without duplicates', () => {
  const names = ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'todo_write', 'spawn_subagent', 'load_skill', 'create_tasks', 'clamic_task', 'get_tasks_detail', 'complate_tasks', 'create_cron_job', 'cancel_cron_job', 'list_cron_job', 'spawn_teammates', 'send_message'];
  expect(toolSchemas.map(schema => schema.function.name)).toEqual(names);
  expect(Object.keys(toolHandlers)).toEqual(names);
  expect(new Set(names).size).toBe(toolSchemas.length);
  expect(tools).toHaveLength(17);
  tools.forEach((tool, index) => {
    expect(tool.schema).toBe(toolSchemas[index]);
    expect(tool.handler).toBe(toolHandlers[tool.schema.function.name]);
    expect(tool.schema.type).toBe('function');
    expect(tool.schema.function.description).toBeTruthy();
    const params = tool.schema.function.parameters!;
    expect(params.type).toBe('object');
    expect(params.additionalProperties).toBe(false);
    const properties = params.properties as Record<string, unknown>;
    for (const key of params.required as string[]) expect(properties).toHaveProperty(key);
  });
});

it.each([
  ['main', 17, ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'todo_write', 'spawn_subagent', 'load_skill',
    'create_tasks', 'clamic_task', 'get_tasks_detail', 'complate_tasks', 'create_cron_job', 'cancel_cron_job',
    'list_cron_job', 'spawn_teammates', 'send_message']],
  ['teammate', 8, ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'todo_write', 'load_skill', 'send_message']],
  ['subagent', 14, ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'todo_write', 'load_skill',
    'create_tasks', 'clamic_task', 'get_tasks_detail', 'complate_tasks', 'create_cron_job', 'cancel_cron_job', 'list_cron_job']],
] as const)('preserves the public tool order and count for %s', (role, count, names) => {
  const selected = toolsForTeamRole(tools, role);
  expect(selected).toHaveLength(count);
  expect(selected.map(tool => tool.schema.function.name)).toEqual(names);
  expect(selected.every(tool => tools.includes(tool))).toBe(true);
  expect(tools).toHaveLength(17);
});

it('keeps optional read limits and TODO status constraints in the public schemas', () => {
  expect(toolSchemas[1]!.function.parameters!.required).toEqual(['path']);
  expect(toolSchemas[1]!.function.parameters!.properties).toMatchObject({ limit: { type: 'number' } });
  expect(toolSchemas[5]!.function.parameters!.properties).toMatchObject({
    todos: { type: 'array', items: {
      required: ['content', 'status'], additionalProperties: false,
      properties: { status: { enum: ['未开始', '进行中', '已完成'] } },
    } },
  });
});

it('fails fast when a schema has no handler', async () => {
  vi.resetModules();
  vi.doMock('../src/tools/handlers.js', () => ({ toolHandlers: {} }));
  await expect(import('../src/tools/index.js')).rejects.toThrow('工具缺少 handler：bash');
});
