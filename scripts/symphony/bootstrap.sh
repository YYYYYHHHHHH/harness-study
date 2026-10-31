#!/usr/bin/env bash
set -euo pipefail
export PATH="$SYMPHONY_NODE_BIN:$PATH"
: "${SYMPHONY_PROJECT_ROOT:?}"
: "${SYMPHONY_WORKSPACE_ROOT:?}"
workspace_root="$(cd "$SYMPHONY_WORKSPACE_ROOT" && pwd -P)"
current_workspace="$(pwd -P)"
if [[ "$(dirname "$current_workspace")" != "$workspace_root" ]]; then
  echo '拒绝在 Symphony 工作区以外初始化。' >&2
  exit 1
fi
export GIT_TERMINAL_PROMPT=0
repository_url="$(git -C "$SYMPHONY_PROJECT_ROOT" remote get-url origin)"
git clone -- "$repository_url" .
git switch -c "codex/symphony-$(basename "$PWD" | tr '[:upper:]' '[:lower:]')"
mkdir -p .symphony
printf '\n.symphony/\n' >> .git/info/exclude
export BEADS_DIR="$PWD/.symphony/beads"
bd init --non-interactive --skip-hooks --skip-agents --prefix symphony
node "$SYMPHONY_PROJECT_ROOT/scripts/symphony/prepare-workspace.mjs"
touch .symphony/bootstrap-complete
