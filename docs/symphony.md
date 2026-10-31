# Symphony + Linear

本项目使用官方 Symphony **v0.0.3** macOS Apple Silicon 自包含安装包，内含 Erlang/Elixir。
安装位置为 `~/.local/share/symphony/v0.0.3/`，安装器和启动检查均验证固定 SHA-256。
官方说明：[Symphony Elixir](https://github.com/openai/symphony/blob/v0.0.3/elixir/README.md)。

Linear 项目：[harness-study](https://linear.app/iluvai/project/harness-study-a664f9cde1d5)，
团队 `ILU`，项目 slugId 为 `a664f9cde1d5`。

## 初次配置

```bash
nvm install
nvm use
npm ci
npm run symphony:install
npm run symphony:key
npm run symphony:doctor
```

启动脚本会优先选择 nvm 已安装的 `.nvmrc` 版本，不修改全局 Node 默认版本。
Linear Personal API Key 在 Linear Settings → Security & access → Personal API keys 中创建，
需要读取项目/任务及更新任务状态的权限。`symphony:key` 用 macOS 隐藏输入窗口保存密钥到
`.symphony.env`（权限 600，Git 忽略）。也可以直接从终端环境提供 `LINEAR_API_KEY`。
Codex 桌面应用的 Linear MCP 登录不能代替这个独立进程的 Key。

Codex 沿用本机 provider 和登录，Symphony 单独固定模型为 `gpt-6-astra`，避免桌面全局
模型变化导致后台任务反复失败。可在启动环境或 `.symphony.env` 设置 `SYMPHONY_CODEX_MODEL`
覆盖，只影响 Symphony。医生检查通过 `initialize` / `account/read` 验证协议与认证；
ChatGPT 登录还会检查 `model/list` 是否包含所选模型。目录可能来自缓存，不进行模型调用，
因此它不证明模型服务可正常推理，实际成功完成任务轮次才证明本次请求可用。
默认 OpenAI provider 未登录时运行 `codex login`；已配置的自定义 provider
可能无需 OpenAI 登录。参考：[App Server](https://developers.openai.com/codex/app-server/)。

## 启动和使用

```bash
npm run symphony:doctor
npm run symphony:start
```

在本机打开 [控制台](http://127.0.0.1:4000)，Ctrl+C 停止。此配置不安装开机启动服务。
日志位于 `.symphony/log/`。Symphony 是实验性预览，启动脚本传入其要求的确认参数；
Codex 保持 workspace-write 沙箱，审批策略为 never。启动适配器只为当前任务克隆的
`.git` 显式增加写权限，并在每轮请求中保留该权限，以支持已授权的 fetch/commit/push。
其他任务目录及 `.codex` 等受保护路径不因此开放；不会关闭整个沙箱。

将任务放入本项目，添加 `symphony` 标签并设为 `Todo`，即可排队。
只有 `Todo` / `In Progress` 且带该标签的任务参与调度，并发数由
`WORKFLOW.md` 的 `agent.max_concurrent_agents` 控制（当前为 2）。
实现并验证通过后，agent 自动 commit、push、创建或更新 PR，并关联到 Linear，
再进入 `In Review`，由人审查与合并；需要返工可移回 `Todo`，继续更新同一 PR。
遇到交付阻塞进入 `Blocked`，并在交付报告和 issue 描述中记录失败。
`In Review` 只用于已创建并关联可验证 PR 的任务。`Blocked` 不自动执行，也不是终态，
因此保留工作区；解除阻塞后可移回 `Todo` 继续。
真实运行任务会使用当前 Codex 模型服务的额度。

工作区位于 `~/.local/share/symphony/workspaces/harness-study/<Linear 编号>/`，
可通过 `SYMPHONY_WORKSPACE_ROOT` 环境变量覆盖。新任务从**主仓库 origin 的远端默认分支**
克隆独立副本，不依赖本地主仓库 HEAD 是否已更新；不复制本地未提交改动或凭据。
每次运行前重新 fetch 默认分支，仅在任务工作树干净、无分叉及无进行中的 Git 操作时
执行 fast-forward。已有任务提交和未提交文件不会被 reset、rebase 或覆盖；不能安全更新时
保留现场，由 agent 检查依赖并记录阻塞。同步结果写入 `.symphony/base-sync.json`。
依赖清单或 Node 版本变化后重新执行 `npm ci`。需要供后续任务使用的代码应先合入远端默认分支。
启动脚本与 WORKFLOW.md 直接从主仓库读取，所以本次环境配置无需提交也可用于启动。

每个副本会安装 npm 依赖、创建 `codex/symphony-<编号>` 分支，并初始化独立 beads 库。
通过 `BEADS_DIR=<工作区>/.symphony/beads` 使用它。Linear 管理调度状态，beads 保留本地
实现任务，不进行自动双向同步，不影响主仓库 beads。任务报告位于工作区的
`.symphony/result.md`。

用户已明确授权 Symphony 自动 commit、push、创建或更新 PR，并把链接关联到 Linear。
这项授权是仓库默认 conservative 策略针对 Symphony 交付流程的例外，无需逐任务再次确认；
任务中更新的明确禁止指令仍优先。仅推送任务专属分支，不直接推送默认分支、不 force-push、
不自动合并或部署、不进行 Dolt 远端同步。本机需要可用的 `gh` 登录及仓库推送权限。

在 `In Review` 时先打开 Linear 关联的 PR，审查代码差异、测试与 CI；本地报告
`.symphony/result.md` 会记录 commit SHA、PR URL 和验证结果。审查通过并合并后再标记
`Done`。依赖任务的克隆仍需取得已合并代码；更改 Linear 状态不会传递文件，已有克隆
也不会自动重置。没有 PR 时先检查交付阻塞说明，不要直接标记完成。

更新此工作流不会自动重新排队已有的 `In Review` / `Done` 任务，也不会追溯创建 PR；
需要继续交付时，应保留原工作区，由人将相应任务移回 `Todo`。
**终态（Done / Canceled / Duplicate）会触发 Symphony 删除任务工作区，
包括尚未提交的改动。** 不要用终态暂存待审查工作。

## 排查

- `unknown variant reject`：当前 Codex 使用 `approval_policy: never`，保留
  `workspace-write` 沙箱。`granular` 还需要实验性协议能力，不能只把旧字段改名。
- `Jason.EncodeError / invalid byte`：Symphony 0.0.3 的工作流换行解析可能切坏中文
  UTF-8 字节。保持 `WORKFLOW.md` 固定模板为英文；插入的 Linear 中文标题和描述不受此限制。
- `FAIL Linear`：检查本地 Key、项目权限与 `WORKFLOW.md` 的 slugId。
- `FAIL Codex`：检查 `codex app-server`、现有 provider 配置或 `codex login`。
- `model_not_found` / “not supported when using Codex with a ChatGPT account”：
  设置 Symphony 的 `SYMPHONY_CODEX_MODEL` 为账号支持的模型；不要让它继承不兼容的桌面默认值。
- `.git/FETCH_HEAD: Operation not permitted`：确认使用最新 `scripts/symphony/codex.sh`
  和 `app-server.mjs`。Symphony 0.0.3 的每轮 sandboxPolicy 会覆盖 CLI 设置，所以只改
  `sandbox_workspace_write.writable_roots` 不够；适配器还为每轮加入当前克隆的绝对 `.git` 路径。
  不要改成全盘写权限。`npm run symphony:test` 验证范围限制与协议透传。
- 任务不运行：检查项目、标签、状态、依赖阻塞及控制台 blocked 信息。
- 前置任务已完成但缺少代码：查看 `.symphony/base-sync.json`。干净且未分叉的分支会在
  下次运行前自动快进；有未提交改动、分叉提交或未结束的 Git 操作时先人工处理，保留工作后再重试。
- 首次初始化失败：查看 `.symphony/log/`；修复 npm/网络/bd 后，只在确认副本无有用改动时
  移走该失败工作区再重试。不要清空已有任务目录。
- 看板端口冲突：修改 `WORKFLOW.md` 的 `server.port`（默认只绑定 127.0.0.1）。
