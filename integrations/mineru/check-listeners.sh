#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "$APP_DIR/env.sh"

exec "$MINERU_VENV/bin/python" "$APP_DIR/runtime_guard.py" check-listeners \
  --state "$MINERU_RUN_DIR/api-state.json" \
  --host "$MINERU_API_HOST" \
  --port "$MINERU_API_PORT"
