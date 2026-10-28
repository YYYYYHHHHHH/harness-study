import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';

export const toolSchemas: ChatCompletionFunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command. With is_slow=true, return a background task ID immediately; a later agent loop delivers the result in a notify_bg_task user message. Commands time out after 120 seconds.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          is_slow: { type: 'boolean', description: '是否在后台执行；默认 false，等待命令结束。true 时立即返回 bgid，完成后通过 XML 通知结果。' },
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
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description: '按名称加载可用 skill 的完整正文。任务匹配 skill 的描述时，先加载再按正文执行。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'system prompt 中列出的 skill name（不是目录名或路径）' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
];

// Preserve the public tool/status spellings requested by the task protocol.
const taskIds = { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true };
toolSchemas.push(
  { type: 'function', function: {
    name: 'create_tasks', description: '创建跨会话持久化任务，保存在工作区 .task/；依赖可引用已有任务或同批任务。',
    parameters: { type: 'object', properties: { tasks: {
      type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
        properties: {
          taskid: { type: 'string', minLength: 1 }, description: { type: 'string', minLength: 1 },
          status: { type: 'string', enum: ['wait', 'procing', 'compleate'] }, depends: taskIds,
        }, required: ['taskid', 'description', 'status', 'depends'],
      },
    } }, required: ['tasks'], additionalProperties: false },
  } },
  { type: 'function', function: {
    name: 'clamic_task', description: '领取一个 wait 且无 owner、所有依赖均已 compleate 的任务。自动设置当前 agent owner 和 procing 状态。',
    parameters: { type: 'object', properties: { task_id: { type: 'string', minLength: 1 } }, required: ['task_id'], additionalProperties: false },
  } },
  { type: 'function', function: {
    name: 'get_tasks_detail', description: '按 task_id 数组查询持久化任务；省略 task_id 查询所有任务，空数组返回空列表。',
    parameters: { type: 'object', properties: { task_id: taskIds }, required: [], additionalProperties: false },
  } },
  { type: 'function', function: {
    name: 'complate_tasks', description: '按 task_id 数组把任务标记为 compleate，保留 owner；重复完成幂等。',
    parameters: { type: 'object', properties: { task_id: { ...taskIds, minItems: 1 } }, required: ['task_id'], additionalProperties: false },
  } },
);

toolSchemas.push(
  { type: 'function', function: {
    name: 'create_cron_job',
    description: '创建定时任务，返回自动生成的 id。到期后等待主 agent 空闲，将 prompt 作为新消息执行；drauble=true 持久化到 .cron/。',
    parameters: { type: 'object', properties: {
      prompt: { type: 'string', minLength: 1, description: '到期时交给主 agent 执行的任务描述/消息' },
      drauble: { type: 'boolean', description: '是否持久化，true 时应用重启后恢复' },
      recurring: { type: 'boolean', description: 'true 重复执行；false 只在下一次到期时执行一次' },
      cron: { type: 'string', minLength: 1, description: '五字段 cron，或六字段（秒 分 时 日 月 周）；使用应用本地时区' },
    }, required: ['prompt', 'drauble', 'recurring', 'cron'], additionalProperties: false },
  } },
  { type: 'function', function: {
    name: 'cancel_cron_job', description: '按 id 取消定时任务，同时移除待消费项及持久化记录；已经开始的执行不会被中断。',
    parameters: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false },
  } },
  { type: 'function', function: {
    name: 'list_cron_job', description: '列出当前全部定时任务（包括未持久化任务）、下次时间和 scheduled/queued/running 状态。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  } },
);
