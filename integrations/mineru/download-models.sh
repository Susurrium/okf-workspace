#!/usr/bin/env bash
set -euo pipefail
umask 0077

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "$APP_DIR/env.sh"
# shellcheck source=lib.sh
source "$APP_DIR/lib.sh"

mineru_ensure_runtime_dirs
exec 7>"$MINERU_RUN_DIR/model-download.lock"
if ! flock -n 7; then
  echo "Another model download is running." >&2
  exit 73
fi

if [[ ! -x "$MINERU_VENV/bin/mineru-models-download" ]]; then
  echo "Run bootstrap.sh first." >&2
  exit 2
fi

export MINERU_MODEL_SOURCE=modelscope
"$MINERU_VENV/bin/mineru-models-download" -s modelscope -m all

"$MINERU_VENV/bin/python" - <<'PY'
import json
import os
from pathlib import Path

config_path = Path(os.environ["MINERU_TOOLS_CONFIG_JSON"])
config = json.loads(config_path.read_text(encoding="utf-8"))
models = config.get("models-dir", {})
for key in ("pipeline", "vlm"):
    value = models.get(key)
    if not value:
        raise SystemExit(f"models-dir.{key} is missing")
    path = Path(value)
    if not path.is_dir():
        raise SystemExit(f"models-dir.{key} does not exist: {path}")
    base = Path(os.environ["MINERU_BASE"]).resolve()
    try:
        path.resolve().relative_to(base)
    except ValueError as exc:
        raise SystemExit(f"model escaped MINERU_BASE: {path}") from exc
    print(f"{key}={path}")

if config.get("llm-aided-config", {}).get("title_aided", {}).get("enable"):
    raise SystemExit("LLM-aided title processing must remain disabled")
PY

chmod 0600 "$MINERU_TOOLS_CONFIG_JSON"
"$APP_DIR/verify-models.sh" --generate
"$APP_DIR/verify-models.sh" --full
du -sh "$MINERU_MODELS_DIR"
echo "Model download and validation complete."
