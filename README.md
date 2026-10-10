# harness-study

一个 TypeScript 代码智能体示例，使用 OpenAI Chat Completions API。需要 Node.js 22.9+。

```bash
npm install
cp .env.example .env
```

在 `.env` 填写 `OPENAI_API_KEY`、`OPENAI_MODEL` 和 `OPENAI_API_BASE_URL`，然后运行 `npm start`，在终端输入任务。加 `--verbose` 可查看工具详情：`npm start -- --verbose`。实际模型调用会使用你的 API 额度。

## 运行结构

- `src/agent.ts`：统一的 `runAgent`，负责消息历史、模型循环、工具执行、hook 生命周期和轮次限制。
- `src/tools/dispatch.ts`：通用工具分发，只允许调用当前 agent 工具集合中的 handler，并校验 JSON 参数为对象。
- `src/tools/schemas.ts` / `handlers.ts` / `index.ts`：分别定义工具 schema、实现及参数校验、schema 与 handler 的组装。
- `src/hooks/`：共用输入、工具前后及停止 hook；通过 `runId` 和 `logPrefix` 区分每次运行。
- `src/index.ts`：CLI 输入、主 agent 配置和最终答复展示。

主 agent 和 subagent 都调用同一个入口：

```ts
const result = await runAgent({
  client,
  model,
  input: task,
  systemPrompt: '你的角色与工作要求',
  tools, // 每个工具包含 schema 和 handler
  logPrefix: '[agent:example]',
  maxRounds: 10,
});
```

返回值为 `{ finished, finalContent, rounds }`。耗尽轮次时 `finished` 为 `false`；模型或 hook 异常向上传播；工具异常作为工具结果交回模型。有效配置下的运行会在 `finally` 中触发 Stop hook。

`spawn_subagent` 是 `handlers.ts` 中的普通工具：复用调用方的客户端和模型，配置独立提示词、消息历史和日志前缀，并移除工具集合中的 `spawn_subagent`。子 agent 仍共享工作目录，完成后向主 agent 返回总结。

## 验证

```bash
npm run check
npm test
```

测试使用模拟模型响应，不访问真实 API，覆盖嵌套 agent、上下文隔离、工具限制、权限拒绝、错误处理及轮次统计。

## 自动化测试与 tools 覆盖率

```bash
npm ci
npm test
npm run test:coverage
npm run check
```

测试使用 Vitest，文件操作仅针对自动清理的临时目录；bash 成功/失败测试使用本地
Node 命令，超时通过模拟子进程错误验证。subagent 的 `runAgent` 被 mock，不调用
真实 LLM 或网络。覆盖率使用 V8，完整纳入 `src/tools/**/*.ts`（包括未被导入的
文件），不排除生产文件或忽略代码行。命令输出 text 报告，并生成
`coverage/coverage-summary.json`；整体及每文件行覆盖率门槛均为 70%，未达标时
命令失败。`coverage/` 是生成物，不纳入版本控制。
