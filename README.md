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
- `src/skills/`：扫描 skill 文件、解析元信息和正文、生成可用 skills 提示词。
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

## Skills

仓库已内置两个 skill，启动 agent 时自动发现，匹配任务后通过 `load_skill` 加载：

| 名称 | 用途 | 示例请求 |
| --- | --- | --- |
| `code_review` | 检查代码规范、类型安全、错误处理和测试覆盖，默认只审查不修改 | `请检查当前改动是否符合代码规范` |
| `commit` | 默认检查并提交全部改动，然后推送到远程 | `请提交本次改动并 push 到当前分支的 upstream` |

`commit` 工作流（包括 `/commit`）默认提交仓库全部改动（已暂存、未暂存、未跟踪及删除），然后执行 push；用户明确指定范围时仅提交该范围。敏感文件、忽略文件和无关生成物不会盲目纳入提交；明确要求“只提交”或“不要推送”时仅提交，只要求 push 时不创建额外提交。仅修改、调试或审查 skill 不会触发实际提交或推送。遇到范围或远程目标不明确、检查失败、冲突等情况会停止并确认，不自动强推或改写历史。新增或修改 skill 后，在下一次 agent 启动时生效。

在工作区根目录（启动时的 `process.cwd()`）下创建 `skills/<目录名>/skill.md`，例如 `skills/code_review/skill.md`：

```markdown
---
name: code_review
description: 审查代码改动，检查正确性、潜在回归和测试覆盖。
---
# 代码审查

1. 阅读改动及相关调用链。
2. 检查边界条件和错误处理。
3. 按严重程度列出问题，附文件位置和修复建议。
```

元信息使用 YAML front matter，`name` 和 `description` 必须是非空字符串，支持引号和多行描述。工具使用元信息中的 `name` 查找 skill，不依赖目录名。

每次主 agent 或 subagent 启动时，递归扫描 `skills/` 下的 `skill.md`（也支持 `SKILL.md`），把名称、描述和完整正文保存到该次运行的内存缓存。system prompt 只注入名称、描述以及加载说明。模型根据任务匹配 skill 后调用 `load_skill({ "name": "code_review" })`，工具返回缓存中的完整 Markdown 正文，不包含 front matter，也不截断正文。文件修改在下一次 agent 启动时生效。

没有 `skills/` 目录时正常启动；格式错误、读取失败或名称重复时，启动失败并报告错误，文件解析错误会附带路径。扫描不跟随符号链接。自定义工具集合需要包含 `load_skill` 才会注入 skills 列表；默认工具集合已包含它。

## CLI slash commands

命令行输入 `/` 会列出本次启动发现的全部 skill 名称和描述；交互终端中在行首或空白后输入 `/` 即显示提示，并支持 Tab 补全。单独输入 `/` 后回车只展示列表，继续等待问题，不调用模型。列表、正文展开和主 agent 的 `load_skill` 复用同一份启动快照。

```text
/code_review 请检查当前改动
/commit 请提交本次改动
/code_review /commit 先审查，再提交修复
```

提交问题前，独立的 `/名称` 引用会替换为对应 skill 的完整 Markdown 正文（不含 front matter），支持多个或重复引用，以及名称中的命名空间、点和空格；正文内的 slash 不会递归展开。URL、普通路径及嵌入普通文本的 slash 不会被替换；未知 skill 会提示警告并保留原始输入。空行仍执行默认的“列出当前目录下的文件”，输入结束（EOF）则退出。

## Token 用量日志

每次模型响应后，默认显示两行摘要：本次输入、输出、总量、本 agent 累计，以及上下文占比、缓存和推理用量。数字使用 K/M/B 缩写，主 agent 与 subagent 通过前缀区分、独立统计。例如：

```text
[main] tokens #2  输入 12.4K · 输出 856 · 本次 13.3K · 累计 26.1K
[main]   └ 上下文 1.24% (12.4K / 1M) · 缓存 4K · 推理 128
```

缺失用量显示 `—`；缓存、推理字段缺失时省略，累计不完整时标记“已知”。加 `--verbose` 或设 `VERBOSE=1` 可查看未缩写的完整单次/累计数值、已知小计及 API 返回的细分字段。缓存、推理属于子项，不重复计入总量。

默认上下文容量按 **1 兆 = 1,000,000 tokens** 设置，可以在 `.env` 中覆盖：

```dotenv
OPENAI_CONTEXT_WINDOW_TOKENS=1000000
```

占比计算为 **最近一次请求实际 `prompt_tokens / 配置容量 × 100%`**，不是累计 token 消耗的占比；不含该次生成的输出及后续工具结果，因此不代表下一次请求的精确占用。该容量仅用于展示，不意味着所选模型实际支持如此大的窗口；请按提供方模型规格调整。配置必须是正的安全整数。

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
