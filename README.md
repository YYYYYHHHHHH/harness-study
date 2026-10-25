# harness-study

一个 TypeScript 代码智能体示例，使用 OpenAI Chat Completions API。需要 Node.js 22.9+。

```bash
npm install
cp .env.example .env
```

在 `.env` 填写 `OPENAI_API_KEY`、`OPENAI_MODEL` 和 `OPENAI_API_BASE_URL`，然后运行 `npm start`，在终端输入任务。每次答复后可继续提问，同一会话保留历史消息与工具结果，支持连续追问；Ctrl+C 或 EOF 退出。默认保留模型思考状态、工具调用/结果状态和 token 用量，不再打印 Round 分隔、重复输入、停止统计或每次工具的详情提示。模型在工具调用前返回的说明也会展示。加 `--verbose` 可查看工具详情：`npm start -- --verbose`。实际模型调用会使用你的 API 额度。

## 运行结构

- `src/agent.ts`：统一的 `runAgent`，负责消息历史、模型循环、工具执行、hook 生命周期和每轮调用前的上下文压缩。
- `src/context-compression.ts`：本地 token 计数、L2/L1 工具压缩、L3 摘要和上下文超长兜底。
- `src/memory/`：模型选择、提取、整理记忆，以及 `.memory` 文件和索引的事务更新。
- `src/tools/dispatch.ts`：通用工具分发，只允许调用当前 agent 工具集合中的 handler，并校验 JSON 参数为对象。
- `src/tools/schemas.ts` / `handlers.ts` / `index.ts`：分别定义工具 schema、实现及参数校验、schema 与 handler 的组装。
- `src/hooks/`：共用输入、工具前后及停止 hook；通过 `runId` 和 `logPrefix` 区分每次运行。
- `src/skills/`：扫描 skill 文件、解析元信息和正文、生成可用 skills 提示词。
- `src/index.ts`：CLI 多轮输入循环、会话历史、主 agent 配置和答复展示。

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

返回值为 `{ finished, finalContent, rounds }`。可选传入 `messages` 数组以跨问题复用会话历史（包含 system、用户输入、模型回复和工具结果，并原地更新压缩后的历史）；不传时仍为独立运行，subagent 默认不共享主会话。不设最大循环次数，持续执行到模型不再调用工具；模型或 hook 异常向上传播；工具异常作为工具结果交回模型。有效配置下的运行会在 `finally` 中触发 Stop hook。

`spawn_subagent` 是 `handlers.ts` 中的普通工具：复用调用方的客户端和模型，配置独立提示词、消息历史和日志前缀，并移除工具集合中的 `spawn_subagent`。子 agent 仍共享工作目录，完成后向主 agent 返回总结。

## 记忆

主 agent 默认启用记忆，使用同一个客户端和模型进行独立调用，用量计入本轮统计。每轮指一次用户提问到最终答复，期间可以包含多次工具调用。子 agent 显式关闭记忆，避免把委派任务误记为用户偏好。

1. **加载**：`load_memory` 在每轮开始时记录用户输入，使用本会话最近 10 条真实用户输入（包含当前提问）和已有记忆的名称、简述、类型、文件索引，让模型选择最多 5 条；无记忆或无相关项返回空。选择请求不包含记忆正文，简述需要写明事实、适用场景和检索关键词。最近输入单独保留，压缩摘要、工具结果和临时记忆不会占用这 10 条。
2. **临时注入**：记录当前用户消息对象作为起点，每次主模型请求在该消息的**下一条**插入参考记忆消息。只修改请求列表副本，不写入持久会话历史。L3 和超长恢复在生成摘要时保留起点对象，再按对象定位新位置，避免固定下标在压缩后失效；临时记忆也计入请求 token 预算。
3. **提取**：最终答复生成后，结合已有记忆和本轮原始用户输入、助手消息、工具结果调用模型提取新候选。本轮记录独立追加深拷贝，不会被 L1/L2/L3 修改，也不会混入临时加载的记忆。长记录按上下文预算分片处理，所有片段都会参与提取，候选在片段之间传递。
4. **整理与保存**：已有记忆或新候选非空时，再调用模型合并重复项、移除有证据被推翻或过时的事实，优先保留 user/feedback，总量最多 **30 条**。不按年龄直接判定过时。提取和整理都成功且结果完整、校验通过后才发布新文件集合，避免半成品覆盖旧记忆。

文件放在启动工作目录的 `.memory/` 中，已加入 `.gitignore`：

```text
.memory/
  MEMORY.md
  memory-<uuid>.md
  ...
```

`MEMORY.md` 使用 YAML front matter 存储索引；`filename` 是相对文件名，`description` 是参与模型选择的重要简述：

```yaml
---
version: 1
memories:
  - filename: memory-<uuid>.md
    name: Python 依赖管理偏好
    description: 在 Python 项目安装依赖、创建环境和运行命令时，用户偏好使用 uv。
    type: user
    updated_at: '2026-10-20T00:00:00.000Z'
---
```

每个记忆文件包含元信息和 Markdown 正文：

```markdown
---
name: Python 依赖管理偏好
description: 在 Python 项目安装依赖、创建环境和运行命令时，用户偏好使用 uv。
type: user
updated_at: '2026-10-20T00:00:00.000Z'
---

用户明确要求之后使用 uv 管理 Python 依赖，替代此前的 pip 工作流。
```

类型为 `user`（用户习惯）、`project`（当前项目信息）、`feedback`（反馈/纠正）、`refence`（项目引用，沿用约定拼写；模型返回 `reference` 时自动归一化）。索引中的名称、简述和类型必须与文件一致；手动编辑时同步更新两处。索引是有效文件集合的依据，不自动导入未登记的 Markdown 文件。

写入先生成新文件，再原子替换 `MEMORY.md`，最后清理旧的已索引文件；不会删除未索引的个人文件。更新在进程内排队，跨进程通过 `.memory/.lock` 防止互相覆盖。进程异常退出可能留下锁，确认没有其他进程更新记忆后可删除该空锁目录。模型/解析/存储失败会提示并继续主会话；无效、截断、超出 30 条或预算不足的结果不会覆盖旧记忆。失败的主模型请求不触发提取。

程序调用 `runAgent` 可传入 `memory: false` 禁用；默认同一个 `messages` 数组复用同一个记忆管理器。也可以显式传入 `new MemoryManager({ client, model, directory })` 自定义目录或管理会话生命周期。记忆文件跨启动保留，最近 10 条用户输入只在当前会话内保留。

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

## 跨会话持久化任务系统

主 agent 和 subagent 均可使用下面四个工具。**接口名称及状态拼写按约定保留**：
`clamic_task`、`complate_tasks`、`wait`、`procing`、`compleate`。

```json
{"tasks":[
  {"taskid":"design","description":"设计接口","status":"wait","depends":[]},
  {"taskid":"implement","description":"实现接口","status":"wait","depends":["design"]}
]}
```

上面是 `create_tasks` 的参数。`tasks` 必须为非空数组；`taskid`、`description` 为非空字符串，
`status` 和 `depends` 必填。新任务通常使用 `wait`；也支持导入 `procing` / `compleate` 状态，
创建时 `owner` 一律为 `null`，不可由模型指定。taskid 在当前工作区全局唯一。
依赖必须已存在或在同一创建批次中给出，支持前向引用，拒绝自依赖、循环和重复 ID。

| 工具 | 参数示例 | 行为 |
| --- | --- | --- |
| `create_tasks` | 上面的 `{ "tasks": [...] }` | 创建任务，返回 `{ok:true,tasks:[...]}` |
| `clamic_task` | `{ "task_id": "design" }` | 校验无 owner、状态为 wait、依赖全为 compleate；成功写入当前 agent owner 和 procing，返回 `{ok:true,task:{...}}` |
| `get_tasks_detail` | `{ "task_id": ["design", "implement"] }` | 按 ID 输入顺序返回 `{ok:true,tasks:[...]}`；省略参数 `{}` 查询全部；空数组返回空列表；不存在的 ID 报错 |
| `complate_tasks` | `{ "task_id": ["design"] }` | 标记为 compleate、保留 owner，返回 `{ok:true,tasks:[...]}`；重复完成幂等 |

owner 来源于运行时 agent 身份，不接受模型指定。CLI 每次启动生成唯一主 agent ID，
连续输入的多轮对话复用同一 ID；每次子 agent 调用生成独立 ID。任务文件跨进程、跨会话保留；
重新启动不会自动重新领取或释放旧 owner。完成工具按协议只按 ID 完成，不额外限制原状态或 owner。

任务保存在 **启动工作目录** 的 `.task/`，每个任务一个 `时间戳-随机UUID.json` 文件，
包含 `taskid`、`description`、`status`、`depends`、`owner`。文件名与任务 ID 分离，更新保留原文件名。
`.task/` 已加入 Git 忽略；不自动删除任务。损坏文件会明确报错，不会静默当作空列表。

所有读写通过同一个 `.task/.lock` 目录锁串行化，单任务更新采用同目录临时文件 + rename，
避免并发重复领取和半写 JSON。等待锁最多 5 秒，不会自动抢夺慢进程持有的锁；若进程崩溃留下锁，
必须确认没有进程正在使用后手动移除 `.task/.lock`。批量创建/完成在写入前校验全部输入；
多个文件不是数据库事务，磁盘错误或进程中断可能造成批次部分落盘，应查询现有状态后重试。
任务目录和 JSON 文件不接受符号链接。文件锁用于遵守本协议的进程，不防御绕过工具直接改文件的外部程序。

验证不调用真实模型 API：

```bash
npm run check
npm test
npm run test:coverage
```

任务系统测试覆盖参数校验、持久化重读、依赖校验、循环依赖、状态转换、重复领取、跨进程抢占、
异常锁释放、损坏文件及工具 handler 接入。
