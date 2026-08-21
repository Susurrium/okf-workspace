#!/usr/bin/env bash
set -euo pipefail
umask 0077

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "$APP_DIR/env.sh"
# shellcheck source=lib.sh
source "$APP_DIR/lib.sh"

MINERU_VERSION=3.4.4
VLLM_VERSION=0.11.2
PIP_VERSION=26.1.2
UV_VERSION=0.11.30
SERVER_LOCK="$APP_DIR/requirements-server.lock"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "MinerU server deployment requires Linux." >&2
  exit 2
fi

command -v python3 >/dev/null
command -v nvidia-smi >/dev/null

mineru_ensure_runtime_dirs
exec 7>"$MINERU_RUN_DIR/bootstrap.lock"
if ! flock -n 7; then
  echo "Another bootstrap or dependency installation is running." >&2
  exit 73
fi

if [[ ! -f "$MINERU_TOOLS_CONFIG_JSON" ]]; then
  install -m 0600 "$APP_DIR/mineru.json" "$MINERU_TOOLS_CONFIG_JSON"
fi

if [[ ! -x "$MINERU_VENV/bin/python" ]]; then
  python3 -m venv "$MINERU_VENV"
fi

"$MINERU_VENV/bin/python" -m pip install --upgrade \
  "pip==$PIP_VERSION" "uv==$UV_VERSION"

if [[ -s "$SERVER_LOCK" ]]; then
  "$MINERU_VENV/bin/uv" pip sync \
    --python "$MINERU_VENV/bin/python" \
    --torch-backend=cu128 \
    --strict \
    "$SERVER_LOCK"
else
  echo "Pinned server dependency lock is missing: $SERVER_LOCK" >&2
  exit 2
fi

"$MINERU_VENV/bin/python" - <<'PY'
import torch
import vllm
from mineru.version import __version__ as mineru_version

assert mineru_version == "3.4.4", mineru_version
assert vllm.__version__ == "0.11.2", vllm.__version__
assert torch.version.cuda == "12.8", torch.version.cuda
assert torch.cuda.is_available(), "CUDA is not available to PyTorch"
assert torch.cuda.get_device_capability(0) == (8, 0)
print(f"mineru={mineru_version}")
print(f"vllm={vllm.__version__}")
print(f"torch={torch.__version__}")
print(f"torch_cuda={torch.version.cuda}")
print(f"gpu={torch.cuda.get_device_name(0)}")
PY

install -m 0600 "$SERVER_LOCK" "$MINERU_CONFIG_DIR/requirements.lock"

"$MINERU_VENV/bin/mineru" --version
"$MINERU_VENV/bin/mineru-api" --help >/dev/null

"$APP_DIR/install-python-headers.sh"

echo "Bootstrap complete: $MINERU_BASE"
