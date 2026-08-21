#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "$APP_DIR/env.sh"
# shellcheck source=lib.sh
source "$APP_DIR/lib.sh"

mineru_validate_base
"$APP_DIR/verify-models.sh" --full
"$MINERU_VENV/bin/python" - <<'PY'
import json
import os
from pathlib import Path

import torch
import vllm
from mineru.version import __version__ as mineru_version

assert mineru_version == "3.4.4"
assert vllm.__version__ == "0.11.2"
assert torch.cuda.is_available()
assert torch.version.cuda == "12.8"
assert "A800" in torch.cuda.get_device_name(0)

base = Path(os.environ["MINERU_BASE"]).resolve(strict=True)
config_path = Path(os.environ["MINERU_TOOLS_CONFIG_JSON"]).resolve(strict=True)
config = json.loads(config_path.read_text(encoding="utf-8"))
assert config["llm-aided-config"]["title_aided"]["enable"] is False
for key in ("pipeline", "vlm"):
    model_path = Path(config["models-dir"][key]).resolve(strict=True)
    model_path.relative_to(base)

print("python-imports=ok")
print(f"mineru={mineru_version}")
print(f"vllm={vllm.__version__}")
print(f"torch={torch.__version__} cuda={torch.version.cuda}")
print(f"gpu={torch.cuda.get_device_name(0)}")
PY

gpu_uuid="$(nvidia-smi -i "$MINERU_GPU_INDEX" --query-gpu=uuid --format=csv,noheader | tr -d '[:space:]')"
[[ "$gpu_uuid" == "$MINERU_EXPECTED_GPU_UUID" ]]

python3 "$APP_DIR/runtime_guard.py" check-health \
  --url "http://$MINERU_API_HOST:$MINERU_API_PORT/health" \
  --version 3.4.4 \
  --concurrency "$MINERU_API_MAX_CONCURRENT_REQUESTS"
"$APP_DIR/check-listeners.sh"
echo "smoke-test=passed"
