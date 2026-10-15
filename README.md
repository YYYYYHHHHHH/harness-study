# harness-study

一个 TypeScript 代码智能体示例，使用 OpenAI Chat Completions API。需要 Node.js 22.9+。

```bash
npm install
cp .env.example .env
```

在 `.env` 填写 `OPENAI_API_KEY`、`OPENAI_MODEL` 和 `OPENAI_API_BASE_URL`，然后运行 `npm start`，在终端输入任务。加 `--verbose` 可查看工具详情：`npm start -- --verbose`。实际模型调用会使用你的 API 额度。

## 运行结构

- `src/agent.ts`：统一的 `runAgent`，负责消息历史、模型循环、工具执行、hook 生命周期和每轮调用前的上下文压缩。
- `src/context-compression.ts`：本地 token 计数、L2/L1 工具压缩、L3 摘要和上下文超长兜底。
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
});
```

返回值为 `{ finished, finalContent, rounds }`。不设最大循环次数，持续执行到模型不再调用工具；模型或 hook 异常向上传播；工具异常作为工具结果交回模型。有效配置下的运行会在 `finally` 中触发 Stop hook。

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
[main]   └ 上下文 1.18% (12.4K / 1.1M) · 缓存 4K · 推理 128
```

缺失用量显示 `—`；缓存、推理字段缺失时省略，累计不完整时标记“已知”。加 `--verbose` 或设 `VERBOSE=1` 可查看未缩写的完整单次/累计数值、已知小计及 API 返回的细分字段。缓存、推理属于子项，不重复计入总量。

默认上下文容量为 **1,050,000 tokens**，最大输出为 **128,000 tokens**，可以在 `.env` 中覆盖：

```dotenv
OPENAI_CONTEXT_WINDOW_TOKENS=1050000
OPENAI_MAX_OUTPUT_TOKENS=128000
```

占比计算为 **最近一次请求实际 `prompt_tokens / 配置容量 × 100%`**，不是累计 token 消耗的占比；不含该次生成的输出及后续工具结果，因此不代表下一次请求的精确占用。容量同时用于调用前压缩，不意味着所选模型实际支持如此大的窗口；请按提供方模型规格调整。配置必须是正的安全整数，窗口必须大于最大输出加 20,000 tokens 安全余量。

## 上下文压缩

主 agent 和 subagent 在每轮模型请求前使用同一压缩机制，分别维护消息与存储目录。正常任务请求通过 [`max_completion_tokens`](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) 传入配置的最大输出。

- **超过 40%（默认 420,000 tokens）**：先 L2，再 L1；均为本地逻辑，不调用模型、不产生 API token 费用。
- **L2**：单条工具结果严格大于 50,000 tokens 时，完整正文写入 `.context/tool-results/<runId>/<uuid>-<时间戳>.txt`。结果替换为标记、绝对路径、本地 token 数、前 1,000 个 Unicode 字符预览和重新读取提示；保留 tool call ID。可用现有 `read_file` 等工具读取，不新增检索工具。
- **L1**：按 L2 处理后的全部工具结果正文计算 token 总量，从最新结果向前累计，保留达到总量 20% 的最少完整条数（跨越边界的整条保留，至少保留最新一条）。更早的正文替换为 `调用结果已被压缩，如果有需要可再次调用。`。已有 L1 占位符和 L2 落盘引用参与统计但不再替换；assistant 的工具名称、参数和调用 ID 保持原样。
- **L2/L1 后仍超过 80%（默认 840,000 tokens）**：触发 L3。保留 system/developer prompt，使用同一模型总结其余全部对话，再用摘要替换；摘要保留用户目标、约束、关键发现、落盘引用、已完成和未完成事项。被替换的历史先保存到 `.transcripts/<runId>/<uuid>-<时间戳>.jsonl`，一行一条原消息，暂不提供检索能力。

超长错误由 `ContextCompressor.recover(messages)` 兜底。按照 `context window - max output tokens - 20,000 - system prompt tokens` 计算前缀预算，向下取到完整消息边界；assistant 的一组 tool calls 和全部结果作为不可拆分的整体。对前缀执行 L3，再拼接未修改的后续消息，重试当前轮，不重复执行工具。非上下文错误直接向上传播。

L3 使用最多 8,192 tokens（不超过配置的 max output）的摘要输出预算，摘要调用计入当前 agent 的用量。历史过大时分段总结并合并先前摘要；摘要请求自身遇到上下文超长会减小输入后重试。写盘失败、摘要为空/截断、没有可压缩完整消息或摘要未缩短上下文时明确报错，保留原消息，避免无限重试。这些错误保护不限制 agent 正常循环轮数。

计数使用本地 `js-tiktoken`：识别模型时使用对应编码，未知模型/供应商别名回退到 `o200k_base`。消息元数据、工具定义和消息封装开销纳入调用前估算；该估算可能与供应商实际 tokenizer 不同，因此同时保留 API 超长兜底。用量日志继续显示 API 返回的实际 token 数。`.context/` 和 `.transcripts/` 已加入 Git 忽略规则。

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
