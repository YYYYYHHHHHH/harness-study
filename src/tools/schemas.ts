import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';

export const toolSchemas: ChatCompletionFunctionTool[] = [
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
  {
    type: 'function',
    function: {
      name: 'spawn_subagent',
      description:
        '派发一个子任务给独立运行的 subagent。subagent 会在自己的 agent loop 中完成任务并返回总结结果。适用于：需要隔离上下文的子探索、相对独立且可一次性交付结果的任务。注意：subagent 内部无法再派发 subagent。',
      parameters: {
        type: 'object',
        properties: {
          subagent_name: {
            type: 'string',
            description: 'subagent 的名称/角色标识，仅用于区分显示和提示词',
          },
          task: {
            type: 'string',
            description: '要交给 subagent 完成的任务的完整描述，包含必要上下文与期望产出',
          },
        },
        required: ['subagent_name', 'task'],
        additionalProperties: false,
      },
    },
  },
];
