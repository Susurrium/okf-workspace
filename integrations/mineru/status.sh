#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "$APP_DIR/env.sh"

STATE_FILE="$MINERU_RUN_DIR/api-state.json"
state_valid=0
if [[ -f "$STATE_FILE" ]]; then
  if python3 "$APP_DIR/runtime_guard.py" status --state "$STATE_FILE"; then
    state_valid=1
  fi
else
  echo "process=stopped"
fi

if (( state_valid == 1 )) \
  && python3 "$APP_DIR/runtime_guard.py" check-health \
    --url "http://$MINERU_API_HOST:$MINERU_API_PORT/health" \
    --version 3.4.4 \
    --concurrency "$MINERU_API_MAX_CONCURRENT_REQUESTS" >/dev/null 2>&1 \
  && "$APP_DIR/check-listeners.sh" >/dev/null 2>&1; then
  echo "api=healthy"
elif ss -H -ltn "sport = :$MINERU_API_PORT" 2>/dev/null | grep -q .; then
  echo "api=unmanaged-listener"
else
  echo "api=unreachable"
fi

nvidia-smi -i "$MINERU_GPU_INDEX" \
  --query-gpu=index,name,memory.total,memory.used,utilization.gpu \
  --format=csv,noheader
