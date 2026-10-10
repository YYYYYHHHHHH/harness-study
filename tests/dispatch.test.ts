import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { dispatchTool, type ToolContext } from '../src/tools/dispatch.js';

function fixture() {
  const handler = vi.fn(async () => 'result');
  const context: ToolContext = {
    client: {} as OpenAI, model: 'test', logPrefix: '', runId: 'test',
    tools: [{ schema: { type: 'function', function: { name: 'example' } }, handler }],
  };
  return { context, handler };
}

describe('dispatchTool', () => {
  it('passes the parsed object and original context to the selected handler', async () => {
    const { context, handler } = fixture();
    expect(await dispatchTool('example', '{"value":42}', context)).toBe('result');
    expect(handler).toHaveBeenCalledExactlyOnceWith({ value: 42 }, context);
  });
  it('rejects disabled tools before parsing arguments', async () => {
    const { context, handler } = fixture();
    await expect(dispatchTool('disabled', 'bad json', context)).rejects.toThrow('当前 agent 未启用工具：disabled');
    expect(handler).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON', async () => {
    const { context, handler } = fixture();
    await expect(dispatchTool('example', '{', context)).rejects.toThrow(SyntaxError);
    expect(handler).not.toHaveBeenCalled();
  });
  it.each(['null', '[]', '42', '"text"', 'true'])('rejects non-object JSON: %s', async json => {
    const { context, handler } = fixture();
    await expect(dispatchTool('example', json, context)).rejects.toThrow('example 的参数必须是 JSON 对象');
    expect(handler).not.toHaveBeenCalled();
  });
  it('propagates handler failures', async () => {
    const { context, handler } = fixture();
    handler.mockRejectedValue(new Error('handler failed'));
    await expect(dispatchTool('example', '{}', context)).rejects.toThrow('handler failed');
  });
});
