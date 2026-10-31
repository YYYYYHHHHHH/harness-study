# harness-study

一个 TypeScript 代码智能体示例，使用 OpenAI Chat Completions API。需要 Node.js 22.9+。

已提供 [Symphony + Linear 本地环境](docs/symphony.md)，使用 `npm run symphony:doctor`
检查，使用 `npm run symphony:start` 启动。调度与 agent 工作约定见 [WORKFLOW.md](WORKFLOW.md)。

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
- `src/cron/`：独立 Worker 中的定时检查、`.cron/` 持久化、任务队列及主线程消费者。
- `src/agent-turns.ts`：用户输入和定时任务共用的主会话串行执行入口。

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

## agent_team：常驻队友与消息

CLI 的 `npm start` 默认启用团队运行时，启动时注册主 agent 的 `main` 路由；teammate 由主 agent
通过工具创建。这里的 **logical independent threads** 指同一进程内可并发的独立异步会话，
不是每个队友一个 OS 线程或子进程。所有角色共享启动工作区，文件修改彼此可见；每位 teammate
独立保留消息历史、稳定 agentId、后台任务 Map 和串行执行入口，后续消息复用自己的会话。
teammate 关闭记忆功能，不继承 main 的聊天历史；任务上下文应写入启动 prompt 或显式发送。

### 工具参数与 main / A / B 寻址

以下是模型工具调用示例，不是 CLI slash 命令或直接可导入的 JavaScript 函数。
A、B 是说明用的角色标签；实际路由必须小写，因此用 `a`、`b`：

```ts
// main 创建 A、B；整个批次注册后才启动各自的 prompt。
spawn_teammates({ teammates: [
  { name: "a", prompt: "检查消息协议，将发现发给 b，并向 main 汇报。" },
  { name: "b", prompt: "检查消息消费测试，收到 a 的发现后核对并向 main 汇报。" },
] });

// main → A（由 main 调用）
send_message({ sender: "main", target: "a", content: "请重点检查名称与身份校验。" });
// A → B（由 a 调用）
send_message({ sender: "a", target: "b", content: "请确认失败消息保留的测试。" });
// B → main（由 b 调用）
send_message({ sender: "b", target: "main", content: "已核对测试，失败队首保留且停止自动消费。" });
```

`spawn_teammates` 必须传非空 `teammates` 数组，每项只含必填的 `name`、`prompt`。
`send_message` 只接受必填的 `sender`、`target`、`content`。两者拒绝缺失、未知字段、类型错误，
以及纯空白 prompt/content；正文原样保留，不做 trim。名称为 1–64 个 ASCII 小写字母、数字、
下划线或连字符，首位必须是字母；不接受大写、空白、点号、路径分隔符及设备保留名
`con`、`prn`、`aux`、`nul`、`com0`–`com9`、`lpt0`–`lpt9`，不做自动归一化。
`main` 可用于消息寻址但不能创建为 teammate；同批重名或会话中已用过的名称均拒绝，
即使启动失败或已 stopped 也不能复用名称。

sender 必须等于运行时绑定的路由名，不能填写内部 agentId、日志前缀或冒充其他角色。
目标必须已注册且仍接收消息；支持 main、其他 teammate 和自投递。忙碌目标也可接收，先入队等待。
teammate 的普通最终答复不会自动转发给 main，汇报结果或阻塞必须显式调用 `send_message`。

| 角色 | 可用工具 |
| --- | --- |
| main | 全部现有工具，加 `spawn_teammates`、`send_message` |
| teammate | 仅 `bash`、`read_file`、`write_file`、`edit_file`、`glob`、`load_skill`、`todo_write`、`send_message` |
| 旧 `spawn_subagent` 子 agent | 原有基础、task、cron 工具；无 `spawn_subagent`、`spawn_teammates`、`send_message`，无团队路由 |

teammate 不能使用持久化任务工具、cron 工具或继续创建 agent；`todo_write` 只展示当前计划。
角色限制同时用于工具 schema 和 dispatcher。它是工具 API 的能力边界，不是文件系统安全沙箱，
共享工作区的 bash/文件操作仍需自行协调，避免同时覆盖同一个文件。

创建工具返回 `{teammates: [{name, agentId, state, error?}, ...]}` 状态快照，不等待任务完成。
参数校验失败时不启动任何成员；批次 inbox 初始化失败时整批不运行模型，返回逐成员错误，
只撤销本批次安全的空注册，保留文件和已使用名称。启动后某位成员的模型失败会停止该成员，
健康成员继续运行，不自动重建失败成员。

投递成功返回 `{id, sender, target, content, created_at, status: "queued"}`；id 和 UTC 时间由总线生成。
**queued 仅表示消息已持久化，不表示已执行或已回复。** 每条消息存于
`.teammates_inbox/<路由名>.jsonl`（包括 `main.jsonl`），磁盘记录不含 status 字段。
同一 inbox 按提交顺序 FIFO，跨发送者的并发投递按取得存储锁的顺序排序，不按时间戳排序。

### 消息循环与退出

一个 loop 指一次 `runAgent` 调用到最终答复的完整模型/工具循环。loop 正常结束后立即检查 inbox，
逐条取队首、包装为含 `type: "team_message"` 和 `message` 的 user 输入，运行独立一轮，
成功完成后才 ack 删除该队首；正文不进入 system prompt，也不在当前 loop 中途注入。
teammate 继续逐条排空，期间新投递也会被读到。main 使用同样的处理边界，但每批最多 16 条，
发现排队的直接输入时先让出入口；余下消息由后续轮次或空闲轮询继续处理，避免用户输入和 cron 饥饿。

空闲时只有一个 **1000ms 单次轮询 timer**，不是 cron job；运行或排队时撤销 timer，
回到空闲才恢复，轮询与输入竞争时也不会重入。同一个 agent 的轮次串行，不同 agent 可并发。
main 的用户输入、cron 和 inbox 共用同一串行入口和历史。

Ctrl+C / SIGINT、SIGTERM 或 EOF 会停止接纳新工作、取消团队与 cron 消费 timer，
CLI 同时中止共享客户端的在途模型 HTTP 请求，再等待已开始的轮次和 I/O 收尾，关闭总线、
cron Worker 并释放所有权锁。尚未开始的输入与消息不再执行；成功结束的在途消息可以 ack，
未完成消息保留。已有工具操作仍需收尾，退出不保证瞬时完成。
程序化调用 `TeamRuntime.stop()` 本身只停止接纳并等待，不主动取消模型请求；宿主负责取消策略。
不通过 CLI 使用 `runAgent` 时需注入运行时绑定的 team client，否则团队工具报“团队运行时未启用”。

### 故障、遗留数据与排查

模型异常、`finished: false`、JSONL 损坏或 I/O/ack 失败会停止受影响 inbox 的自动消费，
保留未确认消息，不跳过坏行，也不每秒无限重试；局部故障不停止健康队友，共享目录/所有权失效
会拒绝整个总线的 I/O。teammate 启动 prompt 失败也会停止该会话。main 直接用户输入失败会沿
CLI 错误路径退出；直接 cron 执行失败由 cron 报告并允许后续轮次，inbox 消费失败则停止该消费者。
参数、身份和投递错误通过工具结果返回给模型；存储错误不会返回 queued。

| 现象 | 检查与处理 |
| --- | --- |
| 名称、sender 或目标被拒绝 | 按上述限制检查小写路由、调用者绑定身份及目标状态；stopping/stopped 不接受新投递 |
| 队友停止回复 | 查看 `[agent:<agentId>] message:<id 或 <direct/unknown>>` 错误日志；程序化宿主可查 `runtime.status()` 的 teammate 状态和 `error`（阶段、说明、时间、可用的 messageId），CLI 没有额外状态查询工具 |
| `OWNERSHIP` / 已有所有者 | 同一工作区只能启动一个总线；确认所有旧实例已停止，再人工移除残留 `.teammates_inbox/.owner.lock` 目录，不按 PID/超时自动抢锁 |
| `RECOVERY_REQUIRED` / 损坏 JSONL | 注册路由时发现非空旧 inbox 或坏记录会拒绝消费；先检查并归档原文件，不能靠反复启动清空或跳过消息。main 注册失败会使 CLI 启动失败；teammate 注册失败返回批次错误 |
| 写入/ack 失败 | 结合 messageId 检查原文件；若 rename 后目录 fsync 失败，提交结果不确定，文件可能已改变，不能盲目重投或重跑 |

退出保留 inbox，重启不自动恢复 agent 会话、历史或后台任务，也不自动消费遗留非空 inbox。
空 inbox 可复用；未注册路由的旧文件仍留在磁盘。底层 `MessageBus.register(name, {recover: true})`
仅供人工检查后的显式恢复，CLI 没有恢复开关，该选项也不恢复模型会话或容忍损坏记录。
不承诺跨崩溃 **exactly-once**：模型成功但 ack 前崩溃，显式恢复后可能重复执行，外部副作用应考虑幂等。

写入采用 inbox 同目录 `.pending-<UUID>` 临时文件、fsync 和原子 rename；所有权锁为
`.teammates_inbox/.owner.lock/`。`.gitignore` 的 `.teammates_inbox/` 覆盖消息、临时文件和锁目录。
异常退出可能留下临时文件和锁，不会在下次启动自动删除；只有确认没有活跃所有者后才人工清理。
实现面向本地小规模团队，每次存储操作读取整个 inbox，变更时重写队列；不支持共享网络盘。

参数与能力定义见 [protocol.ts](src/agent-team/protocol.ts) 和 [capabilities.ts](src/agent-team/capabilities.ts)；
行为回归见 [团队工作流测试](tests/agent-team-workflow.test.ts)、[CLI 集成测试](tests/team-cli.test.ts)
和 [消费器测试](tests/team-consumer.test.ts)。这些测试使用模拟响应或本地 HTTP stub，不调用真实模型 API。

## 每轮上下文快照

每次 agent loop 完成模型调用和本轮全部工具执行后，自动把当前完整的 `messages` 数组保存为格式化 JSON：

```text
.context/messages/<runId>/round-0001.json
.context/messages/<runId>/round-0002.json
```

最终答复和异常退出的循环也会保存；异常时记录截至出错位置的上下文。每次 `runAgent` 调用有独立的 `runId`，
主 agent、subagent 和后续用户轮次的文件不会互相覆盖。快照包括 system、user、assistant、tool 消息及已注入的后台任务通知，
反映该次循环结束时的上下文压缩状态，不包含只在请求时临时注入的参考记忆。
保存完成后才进入下一次循环；写入失败会打印警告，不中断 agent，也不覆盖原始执行错误。
文件位于启动本次运行时的工作目录下，`.context/` 已被 Git 忽略。

## Bash 后台任务

`bash({command: "npm test", is_slow: true})` 会启动异步子进程，立即返回工具结果
`[任务已在后台执行中]bgid：<任务 UUID>`。省略 `is_slow` 或传 `false` 时等待执行结束。
两种模式都沿用 120 秒超时、stdout/stderr 合并以及成功输出最多 50,000 字符的规则，执行前仍经过权限检查。

每个会话的 `bg_task_map` 以任务 UUID 为键，记录 `command`、`started_at`（毫秒时间戳）、
`bg_task_id`、`status`（`running` / `completed` / `failed`）、`result`（运行中为 `null`）、
`origin_tool_id`（原始 tool call ID）和 `notified`。可通过 `runAgent({bg_task_map, ...})` 显式传入 Map 以查看记录；
默认随同一个 `messages` 数组跨轮次复用，独立会话及 subagent 各自隔离。

每次 agent loop 开始、上下文压缩之前，检查已完成或失败且尚未通知的任务，分别追加一条 `role: 'user'` 消息：

```xml
<notify_bg_task><task_id>任务 UUID</task_id><task_result>命令执行结果</task_result><origin_tool_id>原始 tool call ID</origin_tool_id></notify_bg_task>
```

XML 字段会转义特殊字符并替换 XML 不支持的控制字符；Map 保留原始结果。
通知在整组工具结果之后插入，也进入本轮原始记忆记录，每个任务只注入一次。
如果任务在模型生成最终答复期间完成，继续下一次循环处理通知。
如果答复时任务仍在运行，本轮正常结束，结果在同一会话的下一轮载入；后台任务不主动唤醒空闲 agent。
任务仅保存在当前进程内存中，不支持应用重启恢复。

## 定时调度

CLI 启动时加载工作区 `.cron/jobs.json`，初始化 Worker 内的 `cron_jobs`。
独立 Worker 每秒检查到期任务并放入 FIFO 消费队列；主线程消费者每秒检查一次，
只有主 agent 空闲时才取出任务，将 `prompt` 原文作为新一轮 `runAgent` 的 `input`。
定时任务复用主会话历史、agent ID、工具和 hooks；用户输入与定时任务共用串行入口，
包括模型调用、工具执行和记忆整理在内，整轮不会重叠。子 agent 的定时工具也使用同一个调度器。

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `create_cron_job` | `{prompt, drauble, recurring, cron}` | `{ok:true, job:{id,prompt,drauble,recurring,cron}}` |
| `cancel_cron_job` | `{id}` | `{ok:true, cancelled:boolean}`，不存在时为 false |
| `list_cron_job` | `{}` | `{ok:true, jobs:[...]}`，附带 `next_run_at` 和 `status` |

`id` 自动生成 UUID；**`drauble` 沿用约定拼写**，true 才落盘，false 仅当前进程有效。
**`recurring=true` 表示重复执行，false 表示一次性**，一次性任务在表达式的下一个匹配时间触发。
`prompt` 是任务描述，也就是执行时注入的消息，不另外保存 `message` 字段。
列表状态为 `scheduled`、`queued`、`running`；`next_run_at` 是本次待触发/待消费时间的 ISO 时间戳。

例如每天本地时间 9 点执行并跨重启保留：

```json
{
  "prompt": "检查项目测试结果并汇报失败项",
  "drauble": true,
  "recurring": true,
  "cron": "0 9 * * *"
}
```

Cron 支持五字段 `分 时 日 月 周`、六字段 `秒 分 时 日 月 周`，以及范围、列表、步长。
例如 `*/30 * * * * *` 表示每 30 秒；`recurring:false` 时仅执行下一次匹配。
时区使用应用进程的本地时区，可在启动前设置 `TZ=Asia/Shanghai`；改变时区后新计算的触发时间按新时区解释。

每个任务最多有一个等待或执行中的实例。应用停机或 agent 忙碌期间错过的多次触发合并为一次，
重复任务执行结束后计算下一个未来匹配时间，避免历史任务积压。取消会删除存储记录及尚未消费的任务；
已经开始的模型调用不被中断，也不会在结束时重新加入被取消的任务。

持久化采用同目录临时文件加原子 rename，保存调度时间和待执行状态；一次性任务完成后从存储移除。
模型执行报错会显示错误并结束本次尝试，一次性任务仍会移除，重复任务继续下一次调度。
进程异常中断时，尚未确认完成的持久化任务会在重启后重试，因此外部操作需要自行考虑幂等性。
调度/存储错误会停止消费并报告错误，避免静默丢失任务。损坏存储会使启动失败，不会覆盖原文件。

`.cron/` 已加入 Git 忽略。同一目录只能启动一个调度器，以 `.cron/.lock` 目录锁防止重复执行及覆盖。
Ctrl+C、SIGTERM 或 EOF 会停止消费，等待已开始的轮次完成，再关闭 Worker 并释放锁。
强制终止可能留下锁；确认没有其他应用实例后，才能手动移除 `.cron/.lock`。
应用关闭期间不执行任务，重启后恢复持久化任务；这不是操作系统后台服务。

程序化调用时可用 `CronScheduler.start(directory)` 启动服务，并通过 `runAgent({cron, ...})` 注入工具上下文；
需要主动执行时，配合 `CronConsumer` 和 `AgentTurns`，所有共用历史的调用都应通过同一个 `AgentTurns`。
退出时先 `await consumer.stop()`，再 `await cron.stop()`。不传 `cron` 时，定时工具会返回“调度器未启动”。

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
