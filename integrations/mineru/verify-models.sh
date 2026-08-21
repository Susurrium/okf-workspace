#!/usr/bin/env bash
set -euo pipefail
umask 0077

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "$APP_DIR/env.sh"
# shellcheck source=lib.sh
source "$APP_DIR/lib.sh"

mineru_ensure_runtime_dirs
action=verify
full=0
for argument in "$@"; do
  case "$argument" in
    --generate) action=generate ;;
    --full) full=1 ;;
    *) echo "Usage: verify-models.sh [--generate] [--full]" >&2; exit 64 ;;
  esac
done

arguments=(
  "$action"
  --config "$MINERU_TOOLS_CONFIG_JSON"
  --base "$MINERU_BASE"
  --manifest "$MINERU_CONFIG_DIR/model-manifest.json"
)
(( full == 1 )) && arguments+=(--full)
exec python3 "$APP_DIR/model_manifest.py" "${arguments[@]}"
