---
name: commit
description: 安全地检查并暂存指定代码改动、生成提交信息和执行 git commit；用户明确要求时执行 git push，并处理分支、upstream 与失败反馈。
---
# 提交与推送代码

## 授权和安全边界

- 加载本 skill 不代表获得提交或推送授权。根据用户实际请求执行：只要求 commit 时不 push；明确要求 commit 和 push 时可完成两步；只要求 push 时不创建额外提交。
- 只提交用户指定或当前任务产生的改动。发现无关修改、已有暂存内容或范围不明确时先确认，不擅自包含、取消暂存或覆盖其他人的工作。
- 不使用 `git add .`、`git add -A` 或 `git commit -a` 盲目提交全部文件；按确认的路径暂存。同一文件混有无关改动时，先确认范围或使用经过核实的补丁暂存，不能整文件带入。
- 不执行 `reset --hard`、`clean`、`checkout --`、强制推送、`--amend` 或其他破坏性/历史改写操作；如确有需要，停下说明风险并另行获得明确授权。
- 不跳过 hooks、签名或检查，不修改 Git 身份、远程地址或全局配置，不自动 pull、merge 或 rebase。不将密钥、`.env`、凭证或无关生成物纳入提交；`.env.example` 等模板需确认不含真实秘密。
- 分支名、路径、提交信息等输入必须正确进行 shell 引用，路径使用 `--` 分隔；不将不可信文本直接拼接成可执行命令。不在输出中展示凭证或带凭证的远程 URL。

## 执行步骤

### 1. 检查仓库和范围

- 执行 `git rev-parse --show-toplevel`、`git status --short --branch`、`git branch --show-current`、`git diff --stat`、`git diff`、`git diff --cached`，查看最近提交信息以了解风格（例如 `git log -5 --format=%s`）。按需读取未跟踪文件。
- 检查是否存在未解决冲突或正在进行的 merge/rebase/cherry-pick；存在时停止并报告。detached HEAD 状态下先确认目标分支，不擅自创建或切换分支。
- 确认待提交内容和敏感文件。工作区没有改动时不创建空提交；若用户只要求推送或还有未推送提交，继续推送检查。

### 2. 验证改动

- 阅读项目约定和检查脚本，运行相关非自动修复检查。本仓库默认执行 `npm run check`、`npm test`；需要规范审查时可先加载 `code_review`。
- 检查失败时停止提交，报告原因；用户明确要求在已知失败下继续时如实记录，不伪称通过。环境无法运行检查时说明限制并确认是否继续。

### 3. 暂存并提交（仅在用户要求提交时）

- 使用 `git add -- <已确认的路径...>` 暂存目标文件。
- 再检查 `git diff --cached --stat`、`git diff --cached` 和 `git diff --cached --check`，确认暂存区只有授权改动、没有意外文件或空白错误。若暂存内容为空，不创建提交。
- 优先使用用户指定的提交信息，否则遵循仓库现有风格；没有明确约定时使用 `type(scope): 简洁说明`（如 `feat(skills): add review and commit workflows`），描述实际变更而非泛泛的 update。
- 执行 `git commit -m <正确引用的提交信息>`。失败时报告 hook、签名、身份或其他错误，不绕过保护，也不自动修改配置。
- 成功后用 `git log -1 --format='%h %s'` 和 `git status --short --branch` 确认结果。注意 hook 可能改写文件，剩余改动应报告，不自动追加提交。

### 4. 推送（仅在用户明确要求时）

- 确认当前分支、远程及 upstream。可用 `git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'` 查询 upstream；不存在时将其视为需要确认目标，而不是提交失败。
- 已有 upstream 时确认它符合用户目标；没有 upstream 或多个远程/目标有歧义时询问 remote 和 branch，不猜测。首次推送在目标已确认后使用 `git push --set-upstream <remote> <branch>`；已有 upstream 时使用显式目标 `git push <remote> HEAD:refs/heads/<target-branch>`，参数正确引用。
- 推送会包含该分支上所有尚未推送的祖先提交，而不只是本次提交。可在获准联网时 `git fetch <remote>` 更新远端信息，查看目标分支与 HEAD 的差异；发现无关待推送提交或目标分支与当前分支不一致时先确认。远端信息不可用时明确说明，不能假称已同步。
- 使用普通 push。遇到 non-fast-forward、认证失败、网络错误或受保护分支拒绝时停止并报告，不强推、不自动重写历史。
- 以命令成功结果确认推送；若提交成功但推送失败，明确区分两个结果并保留本地提交。

## 最终报告

列出提交范围、执行过的检查及结果、提交短 hash 和信息、推送目标与成功/失败/未执行状态，以及剩余工作区改动。不得把未执行或失败的 commit/push 报告为成功。
