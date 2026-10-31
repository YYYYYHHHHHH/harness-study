#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/../.." && pwd)"
node_version="$(cat "$project_root/.nvmrc")"
if [[ -x "${NVM_DIR:-$HOME/.nvm}/versions/node/v$node_version/bin/node" ]]; then
  export PATH="${NVM_DIR:-$HOME/.nvm}/versions/node/v$node_version/bin:$PATH"
fi
if ! node -e 'const [a,b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 9) ? 0 : 1)'; then
  echo '需要 Node.js 22.9+；请先执行 nvm install && nvm use。' >&2
  exit 1
fi
export SYMPHONY_PROJECT_ROOT="$project_root"
export SYMPHONY_NODE_BIN="$(dirname "$(command -v node)")"
exec node "$project_root/scripts/symphony/manage.mjs" "${@:-doctor}"
