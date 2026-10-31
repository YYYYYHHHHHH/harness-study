# agent_team v1 契约（ILU-6）

本期交付可复用类型、参数 schema/校验、JSONL 编解码、角色过滤和本契约。入口为 `src/agent-team/protocol.ts`、`types.ts`、`capabilities.ts`。消息总线、工具 handler、常驻调度器与 CLI 生命周期由后续模块实现；本期不在生产工具注册表中发布尚无实现的两个新工具，不启动 timer 或调用模型。唯一现有运行路径改动是旧 `spawn_subagent` 的能力隔离保护。

## 对外工具与身份

```ts
spawn_teammates({ teammates: [{ name: "reviewer", prompt: "检查实现" }] })
send_message({ sender: "main", target: "reviewer", content: "请检查协议" })
```

两者根参数必须是对象，满足 `src/tools/dispatch.ts` 的约束。`teamToolSchemas` 提供模型侧 schema；dispatcher 只解析 JSON 和检查根对象，不执行 JSON Schema 校验，因此 handler 必须调用对应 parser。缺少字段、未知字段（包括嵌套字段）、类型错误和纯空白 prompt/content 均拒绝，正文不 trim 或改写。空 teammates 数组拒绝。同批重复名称、已有名称和 `main` 冲突在启动任何 agent 前拒绝。schema 无法表达跨条目 name 唯一性或运行时身份，必须保留运行时校验。

名称采用可移植的严格子集：1–64 个 ASCII 小写字母、数字、`_`、`-`，首位是字母；拒绝设备名 con/prn/aux/nul/com0–9/lpt0–9。不做大小写或空白归一化，拒绝所有点号、路径分隔符、空值、控制字符。`main` 是主 agent 的保留路由名，可作消息 sender/target，不能创建 teammate。名称在整个团队会话中唯一，stopped 后也不复用。稳定的 `agentId` 与路由 name 分离；每次 runAgent 的 `runId` 可以变化。

`AgentTeamClient` 由可信运行时按 agent 绑定身份和角色，不能由工具参数构造。`sendMessage` 再次调用 `parseSendMessageArgs`，以绑定的 name 检查 sender，使用已注册且接受消息的目标集合；不能仅把请求 sender 复制到文件。目标可以是 main、teammate 或自己；未知、stopping、stopped 的目标拒绝。旧 subagent 没有团队路由或团队 client。发件人校验不以模型声明、prompt 或展示名为依据。

`spawnTeammates` 在 registry 锁内重验并一次预留全部名字，避免并发批次的重名竞态。校验失败没有副作用；启动失败需返回各成员可观测状态/error，成功成员保留，失败成员停止，不自动重建或重试，不承诺运行时启动的事务回滚。返回 `{teammates: TeamAgentStatus[]}`，不等待任务完成。`sendMessage` 成功返回 SendMessageReceipt，包含完整 TeamMessage（总线生成的 id/created_at）和 `status: "queued"`；它仅确认可靠入队，不确认已执行或已回复。前置校验错误通过现有 dispatcher/agent 工具错误路径返回；存储失败还必须报告给生命周期所有者并停止相应自动消费，不能只让模型看到错误后无限重试。

## 能力边界

| 角色 | 工具与会话 |
| --- | --- |
| main | 保留现有所有工具，后续接入时额外注册 spawn_teammates、send_message；main 自身所有输入共用一份 AgentTurns |
| teammate | 仅 bash、read_file、write_file、edit_file、glob、load_skill、todo_write、send_message |
| 旧 subagent | 保留原有基础/task/cron 能力；移除 spawn_subagent、spawn_teammates、send_message，不注入团队 client |

teammate 使用显式允许列表，禁用 create_tasks/clamic_task/get_tasks_detail/complate_tasks、所有现有和未来 cron 工具、spawn_subagent/spawn_teammates。todo_write 仅渲染计划，不是持久化任务系统。角色筛选同时用于模型 schema 和 `ToolContext.tools`，因此手工构造的禁止调用也会被 dispatcher 拒绝。main-only spawn 仍须在运行时验证角色，不能只依赖 prompt。

这里定义工具 API 能力，不是 OS 安全沙箱：现有 bash/文件工具依然能访问工作区。消息目录由可信总线管理，不能把可被外部修改的 JSONL 当作可信身份凭据。路径 helper 只负责词法校验，存储实现必须拒绝 inbox 目录/文件的符号链接，以免读写工作区之外的数据。

## 独立会话与调度

“独立线程”指可并发的独立异步 runAgent 会话，首版无需 OS Worker。每个 teammate 拥有自己的 messages 数组、稳定 agentId、bg_task_map 和 AgentTurns，整个生命周期复用这些对象，传入 `memory: false`，不别名引用 main 或其他 teammate 的状态。skills 可复用只读 registry。cron 不传入 teammate。系统提示定义角色，启动 prompt 作为第一次 user 输入。

不同 agent 可以同时运行，同一个 agent 的启动 prompt、inbox 消费、人工输入和其他触发统一经过该 agent 的 AgentTurns，永不重入。main 的 CLI 和现有 cron 调度也要复用 main 的同一 gate。现有 AgentTurns 会继续后续已排队任务，所以每个任务在 gate 内必须再次检查 stopping/stopped/error；仅调用 gate 不等于实现停止语义。

正常流程：预留并注册 idle → gate 内 running 执行启动 prompt → loop 正常结束后立即检查 FIFO head → 每条消息单独运行一次 runAgent 并成功 ack → 重复直到 inbox 清空 → idle。不能在当前模型/tool loop 中途注入或消费团队消息。running 时不保留轮询 timer；只在 idle 时安排 1000ms 的内部 timer，醒来通过 runIfIdle 获取 gate，避免 timer 检查与新输入之间的竞态。禁止用 cron tool 实现轮询。停止前取消 timer，完成 drain/检查后再调度下一个 timer，不用重叠的 async setInterval。

## JSONL 与投递

路径固定为 `<workspace>/.teammates_inbox/{agent_name}.jsonl`，包含 `main.jsonl`。一行一个对象，UTF-8，每条以 LF 结束。例如：

```json
{"id":"bus-generated-unique-id","sender":"main","target":"reviewer","content":"请检查协议\n包括边界条件","created_at":"2026-10-29T00:00:00.000Z"}
```

字段严格为 id、sender、target、content、created_at。id 是总线分配的工作区内唯一非空字符串；created_at 是 `Date.toISOString()` 的 UTC 格式。content 中的换行由 JSON 转义为单行。`decodeInboxMessage` 接受去掉行分隔符的一行，不接受多个记录。读取必须验证 record.target 等于所在 inbox 的路由名；不能把记录重路由到另一个文件。

正常运行保证每个 inbox 的 append 提交顺序 FIFO；不同并发 sender 以总线取得该 inbox 锁的顺序排序，不按时间戳或全局排序。单工作区仅允许一个总线所有者（第二个进程启动应明确失败）。每个 inbox 的 append、peek、ack 共享串行 I/O 锁；不要将整个模型执行锁住，以允许期间接收新消息。

`peek` 保留磁盘 head，以 AgentTurns 确保只有一个在途消费者。仅在 runAgent 正常 finished 后 `acknowledge(target, id)` 移除匹配的 head。ack 必须在锁内读取最新队列再提交更新，不得用运行模型前的旧队列覆盖文件，否则会丢失期间 append 的消息。实现可以使用同目录临时文件、同步写入和原子 rename 提交；append 与 ack 必须采用同一锁/提交策略。可靠入队确认必须晚于持久化成功。ack ID 不匹配是可观测错误，不能跳过队首或删除其他记录。

消息通过 `teamMessageToUserEvent` 包装为 `role: 'user'`，content 是含 type 与 message 对象的 JSON；sender、target、正文是分离字段。集成现有 runAgent 时可传该事件的 JSON content 作为 input，让 runAgent 追加一次 user 事件，不能提前追加后又传 input 导致双重输入。不把正文、sender 或磁盘消息拼入 system prompt，不将它们解释为 system/tool 指令。

## 生命周期、错误与恢复边界

| 当前状态 | 事件 | 结果 |
| --- | --- | --- |
| idle | gate 接纳启动/输入/消息 | running，撤销 timer |
| running | 成功完成且仍有消息 | 保持 gate，按序逐条执行并 ack |
| running | 队列清空 | idle，1000ms 后再检查 |
| idle/running | stop 或模型/存储故障 | stopping，禁止新执行与投递接纳，撤销 timer |
| stopping | 活跃 loop 与已开始 I/O 收尾 | stopped，保留错误与 inbox |
| stopped | timer/排队任务到达 | 不执行；无自动重启转换 |

错误保存在 `TeamAgentStatus.error`，含阶段、说明、时间及可用的 messageId，由 status/日志可观测。模型异常或 `finished: false` 保留未 ack 消息、当前历史和错误，停止该 agent 自动重试；启动 prompt 失败保留 session.prompt/历史/错误。JSON 解析失败、半行记录、目标不匹配、I/O/ack 失败保留原始文件和可恢复记录，不跳过坏行，不按 1000ms 重试。若无法持久化错误，至少在内存状态和日志报告失败，不能声称已写入恢复记录。共享目录级存储失败停止整个团队，局部故障至少停止受影响 agent。

stop 是幂等的：停止接纳新工作，等待当前 loop 收尾，成功的在途消息可以 ack；失败的仍保留。未开始的排队任务不执行，不继续 drain；不得清空 inbox，也不删除历史错误。既有 runAgent 没有强制中断接口，因此 stop 不保证即时结束，后续模块若增加超时必须报告仍在途状态，不能提前宣称 stopped。

本契约保证正常进程运行中的 FIFO、同一消息不被并发消费、append/dequeue 无丢失；不承诺跨进程崩溃 exactly-once（执行成功但 ack 前崩溃可能重复），也不自动恢复会话。退出保留所有 inbox。启动发现遗留非空/损坏文件时拒绝自动创建并消费该路由，要求显式人工检查、归档或恢复；空文件可复用。不能截断旧文件或因名称重复自动吞掉遗留消息。

## 验收及后续接入

本期测试覆盖 schema 和 parser 的对象根约束、空数组、重名/已占用名/保留名/非法名、空 prompt/content、缺失/未知字段、运行时 sender 伪造、非法/未知目标、JSONL 单行往返、user 事件隔离、角色过滤及旧 subagent 回归。测试通过真实 dispatchTool 调用 parser；不调用真实模型。

后续 runtime 接入必须在上述 API 下测试：并发 append/ack 不丢数据、同 agent 不重入、跨 agent 并行、running 无 timer、loop 后 drain、idle 1000ms 唤醒、失败只执行一次并保留 head、坏行/遗留文件处理、stop 与在途任务竞态、稳定会话对象及 memory:false。这些运行时行为在本期是契约，尚未声称实现。

## JSONL 总线实现（ILU-7）

`MessageBus.open(workspace)`（`src/agent-team/message-bus.ts`）取得工作区独占所有权；`register(name)` 创建或复用空 inbox，绝不截断旧文件。`main` 与 teammate 使用同一接口。非空旧文件返回 `RECOVERY_REQUIRED`（带队头 id），只有人工检查后显式 `register(name, { recover: true })` 才能恢复；损坏文件即使指定恢复也拒绝。恢复不会认证历史 sender，也不会恢复模型会话。

可信 runtime 通过 `append({ sender, target, content })` 投递；必须先按绑定身份调用协议 parser，不能把总线的结构校验当作身份认证。调用方只能经总线读写 inbox，不能在 handler 中直接改文件。总线验证 sender/target 已注册且未失败，分配 UUID 和 UTC 时间，成功返回时记录已持久化。

消费顺序为 `peek(target)` → 运行一条消息 → `acknowledge(target, message.id)`。`peek` 在内存预留队头并保留磁盘记录；第二次 peek 返回 `RESERVED`，不会向另一个消费者重复交付。运行期间仍可 append，ack 在同一 I/O 互斥锁中重读最新文件，只删除匹配的队头。全部路由共享短时 I/O 互斥锁，模型运行不占此锁。此实现对每次操作读取整个 inbox，并对变更重写整个队列，适用于本地小规模团队；未做大队列性能优化。

运行异常或 `finished: false` 时调用 `fail(target, id, cause)`：保留磁盘消息及预留，拒绝该路由的后续投递、peek 和 ack。`error(target)` 返回含原因和 messageId 的错误，关闭后仍可查询。调用方生命周期必须同步保存/记录错误并停止该 agent。存储/完整性错误会拒绝当前操作并停止整个总线的后续操作；总线没有 timer、自动重试、隐式解除预留或死信跳过机制。`close()` 停止接纳，等待已接纳 I/O 后释放锁，幂等且不清空文件；runtime 应先等待活跃模型任务及其 ack/fail，再 close。

文件为严格 UTF-8 JSONL：空文件有效，一个末尾 LF 可选，完整但没有末尾 LF 的旧记录可读取，下次成功提交时规范化为 LF。空白行、额外空行、CRLF、非法 UTF-8、截断 JSON、错误字段、重复 id、target 与文件名不符均报告路径/行号或编码错误，不跳过任何行；验证整个队列后才交付队头。错误原因为 `InboxError.cause`，外层存储错误还包含原因文本及可用的 messageId。名称限制复用 ILU-6；root 拒绝符号链接/非目录，inbox 拒绝符号链接、硬链接和非普通文件，每次操作重验目录与锁的身份，文件打开使用 NOFOLLOW 并复核 inode。

所有修改均在同目录独占创建临时文件，写入、fsync、原子 rename 后 fsync 目录。提交前故障保留原文件；rename 后目录 fsync 失败属于**提交结果不确定**，文件可能已改变，错误仍会停止整个总线，必须人工按 messageId 检查，不能盲目重投/重跑。进程意外退出可能留下 `.pending-*`，这些不是消息记录，只有排除活跃所有者后才可人工清理。跨崩溃不承诺 exactly-once，模型成功但 ack 前崩溃仍可能在显式恢复后重复执行。

`.teammates_inbox/.owner.lock` 使用原子 mkdir 独占；同进程的另一总线和其他 CLI 都立即报 `OWNERSHIP`，不会等待或抢占。正常 close 释放锁，异常退出的残留锁必须确认所有 CLI 已停止后手工移除，然后检查/归档 inbox 并选择显式恢复；不按 PID/超时自动删除锁。仅支持具备本地原子 mkdir/rename、NOFOLLOW 和目录 fsync 语义的文件系统；未支持共享网络盘。工作区仍是可信文件系统边界，不承诺防御拥有同等文件权限的恶意进程在检查与操作间反复替换目录。所有运行文件均被 `.gitignore` 排除，已有文件不会被清空。

## 团队运行时与批量启动（ILU-8）

`TeamRuntime.create({ workspace, client, model, tools, skills, bus?, runAgent? })` 注册 main inbox 并建立会话所有者。默认打开真实 MessageBus，测试可注入 bus 和 runAgent。宿主通过 `runtime.clientFor('main')` 将绑定身份的 client 注入 `AgentOptions.team`；teammate 的 client 由运行时注入。`AgentOptions.role` 与 `ToolContext.role` 默认 main，teammate 使用显式允许列表；runAgent 对模型 schema 过滤，dispatchTool 再独立检查角色，完整工具表也不能绕过限制。旧 subagent 不获得团队 client，继续沿用原有行为。

`spawn_teammates` 和 `send_message` 已注册到 schemas/handlers/index。未注入团队服务时明确返回“团队运行时未启用”。send_message 只调用绑定 client 完成验证与持久化入队；本期不增加自动 inbox 消费、idle timer 或 CLI 生命周期接线，这些仍由后续任务实现。

批量启动先复制和校验所有参数，在 registry gate 内重验并预留全部名称，所有 inbox 注册成功后才公开路由并调度独立初始轮次。工具返回状态快照，不等待模型完成。同批模型可立即互相投递；不同 teammate 并行，同一 teammate 的所有轮次经过自己的 AgentTurns。

初始化失败时整个新批次不运行模型，返回每个成员的 startup/storage 错误。`MessageBus.unregisterEmpty` 只撤销本次已成功注册且无消息、无预留消费的路由，不删除文件；已有消息、坏文件及其他批次均保留。空注册清理后移除对应会话，已使用名称仍保留，禁止隐式重试。非空或无法确认安全的注册保留为 stopped 会话，错误可通过 status 和日志检查。共享存储失败停止全团队接纳。

`runtime.runTurn(name, input)` 为后续消费者保留执行入口：它复用该 teammate 的 messages、agentId、bg_task_map、AgentTurns，始终 memory:false，不传入 cron。消费者须先用 teamMessageToUserEvent 包装消息，并在成功后 ack；此入口本身不读取、ack 或轮询 inbox。失败轮次记录错误并停止该会话，不自动重试。`runtime.stop()` 幂等停止接纳，等待已接纳的初始化、I/O 与模型轮次，跳过未开始的排队轮次，再关闭总线；不清空任何 inbox。

ILU-8 测试使用 mock runAgent/模型响应及临时目录，覆盖并发启动、即时返回、同批寻址、跨轮次状态隔离、重名竞态、初始化回滚与消息保留、停止竞态、模型/存储失败和 schema/dispatch 双层角色约束。


## 消息投递与 main 路由（ILU-9）

生产注册表中的 `send_message({ sender, target, content })` 通过当前上下文的绑定 client 校验身份。公开路由名与内部 agentId、role、logPrefix 无关；sender 必须与绑定名称严格一致。未知字段、缺失字段、空白正文、非法名称和未注册目标均拒绝。注册表锁内再次检查生命周期，stopping/stopped 的发送方或目标明确报错，不能通过缓存的 client 继续发消息。

工具回执是 `{ id, sender, target, content, created_at, status: "queued" }`。`queued` 只在统一 MessageBus 完成持久化后返回，不代表目标处理或回复。磁盘记录仍严格保持五个 TeamMessage 字段，绝不将回执 status 写入 JSONL。I/O 错误通过工具错误路径返回，运行时记录 storage 错误并停止团队接纳，不返回成功回执。

main 在创建 TeamRuntime 时注册，路径固定为 `.teammates_inbox/main.jsonl`。main→teammate、teammate→teammate、teammate→main 和自投递使用同一总线；空闲与繁忙目标均先落盘。handler/client 不调用 runAgent，不等待目标响应，不触发递归或嵌套 agent loop。

teammate 系统提示给出向 main 汇报结果/阻塞的具体 send_message 调用，并明确普通 finalContent 不会自动发送。运行时保留显式发送的单条结果，不将每次 finalContent 再复制到 main inbox。

消费边界沿用 `teamMessageToUserEvent`：JSON 包装保留 id/sender/target/created_at 和原始正文，以一次 user 输入交给 runAgent；正文含换行、JSON 或 system 提示词片段也不会改写 system 消息。测试通过 mock 模型验证 main 和 teammate 均保留此边界。自动 pump、idle timer 及 CLI 生命周期接线仍按前述契约由后续模块提供；本任务未在发送路径增加消费器。
