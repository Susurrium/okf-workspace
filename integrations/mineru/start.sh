#!/usr/bin/env bash
set -euo pipefail
umask 0077

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "$APP_DIR/env.sh"
# shellcheck source=lib.sh
source "$APP_DIR/lib.sh"

STATE_FILE="$MINERU_RUN_DIR/api-state.json"
START_LOCK="$MINERU_RUN_DIR/start.lock"

mineru_ensure_runtime_dirs
exec 8>"$START_LOCK"
if ! flock -n 8; then
  echo "Another MinerU lifecycle command is in progress." >&2
  exit 73
fi

if [[ -f "$STATE_FILE" ]]; then
  set +e
  state_output="$(python3 "$APP_DIR/runtime_guard.py" status --state "$STATE_FILE" 2>&1)"
  state_status=$?
  set -e
  if (( state_status == 0 )); then
    if python3 "$APP_DIR/runtime_guard.py" check-health \
      --url "http://$MINERU_API_HOST:$MINERU_API_PORT/health" \
      --version 3.4.4 \
      --concurrency "$MINERU_API_MAX_CONCURRENT_REQUESTS" >/dev/null 2>&1 \
      && "$APP_DIR/check-listeners.sh" >/dev/null 2>&1; then
      echo "MinerU API is already running and healthy."
      exit 0
    fi
    echo "$state_output" >&2
    echo "A validated MinerU session exists but is not healthy; stop it before restarting." >&2
    exit 3
  elif (( state_status == 1 )); then
    python3 "$APP_DIR/runtime_guard.py" stop \
      --state "$STATE_FILE" --output-parent "$MINERU_JOBS_DIR/output"
  else
    echo "$state_output" >&2
    echo "Refusing to replace invalid service state." >&2
    exit 3
  fi
fi

if mineru_is_port_listening; then
  echo "Port $MINERU_API_PORT is already in use." >&2
  exit 3
fi

"$APP_DIR/cleanup-runtime.sh"
log_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_FILE="$(mktemp "$MINERU_LOG_DIR/api-$log_stamp-XXXXXX.log")"
chmod 0600 "$LOG_FILE"
export MINERU_ACTIVE_LOG="$LOG_FILE"

ulimit -n 65535
nohup setsid "$APP_DIR/run-api.sh" >>"$LOG_FILE" 2>&1 </dev/null &
launcher_pid=$!

cleanup_failed_start() {
  if [[ -f "$STATE_FILE" ]]; then
    "$APP_DIR/stop.sh" --force --purge-output || true
  fi
}

for _ in {1..180}; do
  if curl --silent --fail --max-time 2 "http://$MINERU_API_HOST:$MINERU_API_PORT/health" >/dev/null; then
    if python3 "$APP_DIR/runtime_guard.py" check-health \
      --url "http://$MINERU_API_HOST:$MINERU_API_PORT/health" \
      --version 3.4.4 \
      --concurrency "$MINERU_API_MAX_CONCURRENT_REQUESTS" \
      && "$APP_DIR/check-listeners.sh"; then
      echo "MinerU API is healthy (launcher PID $launcher_pid, log $LOG_FILE)."
      exit 0
    fi
    echo "Health or listener validation failed; cleaning up the owned session." >&2
    cleanup_failed_start
    tail -n 80 "$LOG_FILE" >&2 || true
    exit 7
  fi
  if ! kill -0 "$launcher_pid" 2>/dev/null; then
    echo "MinerU API exited during startup. See $LOG_FILE" >&2
    cleanup_failed_start
    tail -n 80 "$LOG_FILE" >&2 || true
    exit 7
  fi
  sleep 2
done

echo "MinerU API did not become healthy within 360 seconds." >&2
cleanup_failed_start
tail -n 80 "$LOG_FILE" >&2 || true
exit 8
