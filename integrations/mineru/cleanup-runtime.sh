#!/usr/bin/env bash
set -euo pipefail
umask 0077

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "$APP_DIR/env.sh"
# shellcheck source=lib.sh
source "$APP_DIR/lib.sh"

mineru_ensure_runtime_dirs
STATE_FILE="$MINERU_RUN_DIR/api-state.json"

python3 "$APP_DIR/runtime_guard.py" cleanup-orphans \
  --state "$STATE_FILE" \
  --output-parent "$MINERU_JOBS_DIR/output" \
  --retention-minutes "$MINERU_ORPHAN_RETENTION_MINUTES"
python3 "$APP_DIR/runtime_guard.py" cleanup-logs \
  --log-dir "$MINERU_LOG_DIR" \
  --retention-days "$MINERU_LOG_RETENTION_DAYS" \
  --retain-count "$MINERU_LOG_RETAIN_COUNT"
python3 "$APP_DIR/runtime_guard.py" cleanup-rpc-orphans \
  --state "$STATE_FILE" \
  --run-parent "$MINERU_RUN_DIR" \
  --retention-minutes "$MINERU_ORPHAN_RETENTION_MINUTES"
