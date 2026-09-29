import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';

const tools: ChatCompletionTool[] = [{
  type: 'function',
  function: {
    name: 'get_current_time',
    description: '查询指定 IANA 时区的当前日期和时间',
    parameters: {
      type: 'object',
      properties: {
        timeZone: {
          type: 'string',
          description: 'IANA 时区，例如 Asia/Shanghai',
        },
      },
      required: ['timeZone'],
      additionalProperties: false,
    },
  },
}];

async function executeTool(name: string, argumentsJson: string): Promise<string> {
  if (name !== 'get_current_time') {
    throw new Error(`未知工具：${name}`);
  }

  const args: unknown = JSON.parse(argumentsJson);
  if (
    typeof args !== 'object' || args === null ||
    !('timeZone' in args) || typeof args.timeZone !== 'string'
  ) {
    throw new Error('get_current_time 的 timeZone 参数无效');
  }

  return JSON.stringify({
    timeZone: args.timeZone,
    currentTime: new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'full',
      timeStyle: 'long',
      timeZone: args.timeZone,
    }).format(new Date()),
  });
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  const baseURL = process.env.OPENAI_API_BASE_URL;

  if (!apiKey || !model || !baseURL) {
    throw new Error('请在 .env 中填写 OPENAI_API_KEY 和 OPENAI_MODEL');
  }

  const client = new OpenAI({ apiKey, baseURL });
  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'user',
      content: '请告诉我上海现在的时间',
    },
  ];
  const maxRounds = 10;

  for (let round = 0; round < maxRounds; round += 1) {
    const response = await client.chat.completions.create({
      model,
      messages,
      tools,
      tool_choice: 'auto',
    });
    const message = response.choices[0]?.message;

    if (!message) {
      throw new Error('模型未返回消息');
    }

    messages.push(message);
    const toolCalls = message.tool_calls ?? [];

    if (toolCalls.length === 0) {
      console.log(message.content ?? '');
      return;
    }

    for (const toolCall of toolCalls) {
      if (toolCall.type !== 'function') {
        throw new Error(`不支持的工具调用类型：${toolCall.type}`);
      }

      let content: string;
      try {
        content = await executeTool(
          toolCall.function.name,
          toolCall.function.arguments,
        );
      } catch (error) {
        content = JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        });
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content,
      });
    }
  }

  throw new Error(`Agent Loop 超过最大轮次 ${maxRounds}`);
}


main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
