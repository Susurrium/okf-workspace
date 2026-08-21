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
force=0
purge=0
for argument in "$@"; do
  case "$argument" in
    --force) force=1 ;;
    --purge-output) purge=1 ;;
    *) echo "Usage: stop.sh [--force] [--purge-output]" >&2; exit 64 ;;
  esac
done

if [[ ! -f "$STATE_FILE" ]]; then
  echo "MinerU API is not recorded as running."
  exit 0
fi

arguments=(
  stop
  --state "$STATE_FILE"
  --output-parent "$MINERU_JOBS_DIR/output"
)
(( force == 1 )) && arguments+=(--force)
(( purge == 1 )) && arguments+=(--purge-output)
exec python3 "$APP_DIR/runtime_guard.py" "${arguments[@]}"
