#!/usr/bin/env bash
set -euo pipefail
umask 0077

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "$APP_DIR/env.sh"
# shellcheck source=lib.sh
source "$APP_DIR/lib.sh"

LOCK_FILE="$MINERU_RUN_DIR/api.lock"
STATE_FILE="$MINERU_RUN_DIR/api-state.json"
OUTPUT_PARENT="$MINERU_JOBS_DIR/output"

mineru_ensure_runtime_dirs
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another MinerU API process owns $LOCK_FILE" >&2
  exit 73
fi

"$APP_DIR/preflight.sh"

if [[ -z "${MINERU_ACTIVE_LOG:-}" || ! -f "$MINERU_ACTIVE_LOG" ]]; then
  echo "run-api.sh is an internal entry point; use start.sh." >&2
  exit 74
fi
log_real="$(realpath -e -- "$MINERU_ACTIVE_LOG")"
log_parent="$(realpath -e -- "$MINERU_LOG_DIR")"
if [[ "$(dirname -- "$log_real")" != "$log_parent" ]]; then
  echo "Active log escaped $MINERU_LOG_DIR" >&2
  exit 74
fi

session_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
session_output="$(mktemp -d "$OUTPUT_PARENT/session-$session_stamp-$$-XXXXXX")"
chmod 0700 "$session_output"
export MINERU_API_OUTPUT_ROOT="$session_output"
export VLLM_RPC_BASE_PATH="$MINERU_RUN_DIR/vllm-rpc-$$"
install -d -m 0700 "$VLLM_RPC_BASE_PATH"

env -u PYTHONPATH MINERU_LOOPBACK_TCPSTORE=0 python3 "$APP_DIR/runtime_guard.py" write-state \
  --state "$STATE_FILE" \
  --pid "$$" \
  --output "$session_output" \
  --rpc "$VLLM_RPC_BASE_PATH" \
  --log "$MINERU_ACTIVE_LOG"

api_pid=""
clear_state() {
  env -u PYTHONPATH MINERU_LOOPBACK_TCPSTORE=0 \
    python3 "$APP_DIR/runtime_guard.py" clear-state \
    --state "$STATE_FILE" --pid "$$" 2>/dev/null || true
}
forward_signal() {
  if [[ -n "$api_pid" ]]; then
    kill -TERM "$api_pid" 2>/dev/null || true
  fi
}
trap clear_state EXIT
trap forward_signal TERM INT HUP

# Only the MinerU virtualenv process tree receives the TCPStore adapter.  The
# explicit canary makes sitecustomize fail closed even though CPython normally
# treats some sitecustomize import failures as non-fatal.
export MINERU_LOOPBACK_TCPSTORE=1
export PYTHONPATH="$APP_DIR/python_startup"
"$MINERU_VENV/bin/python" - <<'PY'
import importlib

rendezvous = importlib.import_module("torch.distributed.rendezvous")
if not getattr(rendezvous, "_mineru_loopback_tcpstore_guard", False):
    raise SystemExit("MinerU loopback TCPStore guard was not installed")
PY

"$MINERU_VENV/bin/mineru-api" \
  --host "$MINERU_API_HOST" \
  --port "$MINERU_API_PORT" \
  --enable-vlm-preload true \
  --gpu-memory-utilization "$MINERU_GPU_MEMORY_UTILIZATION" &
api_pid=$!
wait "$api_pid"
