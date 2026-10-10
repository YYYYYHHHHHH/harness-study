import type { ChatCompletionTool } from 'openai/resources/chat/completions';

export const tools: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read file contents.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（相对工作区或绝对路径）' },
          limit: { type: 'number', description: '最多读取的行数，可选' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace text in file once.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
        },
        required: ['path', 'old_text', 'new_text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files by pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob 模式，例如 src/**/*.ts' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description:
        '写入/更新当前任务的 TODO 计划，渲染到终端供用户查看。执行任何其他工具前必须先调用一次来规划步骤，后续可反复调用以更新状态。',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '任务列表，按执行顺序排列',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '任务内容描述' },
                status: {
                  type: 'string',
                  enum: ['未开始', '进行中', '已完成'],
                  description: '任务状态',
                },
              },
              required: ['content', 'status'],
              additionalProperties: false,
            },
          },
        },
        required: ['todos'],
        additionalProperties: false,
      },
    },
  },
];
