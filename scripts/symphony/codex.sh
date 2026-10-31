#!/usr/bin/env bash
set -euo pipefail
export PATH="$SYMPHONY_NODE_BIN:$PATH"
export BEADS_DIR="$PWD/.symphony/beads"
exec node "$SYMPHONY_PROJECT_ROOT/scripts/symphony/app-server.mjs"
