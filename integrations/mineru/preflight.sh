#!/usr/bin/env bash
set -euo pipefail
umask 0077

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "$APP_DIR/env.sh"
# shellcheck source=lib.sh
source "$APP_DIR/lib.sh"

mineru_ensure_runtime_dirs

if [[ "$MINERU_API_HOST" != "127.0.0.1" ]]; then
  echo "The MinerU API must bind exactly to 127.0.0.1." >&2
  exit 2
fi
if [[ "$VLLM_HOST_IP" != "127.0.0.1" || "$MASTER_ADDR" != "127.0.0.1" ]]; then
  echo "vLLM and PyTorch distributed coordination must use loopback." >&2
  exit 2
fi
if [[ "$GLOO_SOCKET_IFNAME" != "lo" || "$NCCL_SOCKET_IFNAME" != "lo" ]]; then
  echo "Distributed communication interfaces must be lo." >&2
  exit 2
fi
if [[ ! "$MINERU_API_PORT" =~ ^[0-9]+$ ]] || (( MINERU_API_PORT < 1 || MINERU_API_PORT > 65535 )); then
  echo "Invalid API port: $MINERU_API_PORT" >&2
  exit 2
fi

if [[ ! -x "$MINERU_VENV/bin/mineru-api" ]]; then
  echo "Run bootstrap.sh first." >&2
  exit 2
fi
if [[ ! -f "$APP_DIR/python_startup/sitecustomize.py" ]]; then
  echo "The loopback-only PyTorch TCPStore guard is missing." >&2
  exit 2
fi
if [[ ! -s "$MINERU_TOOLS_CONFIG_JSON" ]]; then
  echo "MinerU configuration is missing: $MINERU_TOOLS_CONFIG_JSON" >&2
  exit 2
fi
"$APP_DIR/verify-models.sh"
if mineru_is_port_listening; then
  echo "Port $MINERU_API_PORT is already in use." >&2
  exit 3
fi

gpu_uuid="$(nvidia-smi -i "$MINERU_GPU_INDEX" --query-gpu=uuid --format=csv,noheader | tr -d '[:space:]')"
if [[ "$gpu_uuid" != "$MINERU_EXPECTED_GPU_UUID" ]]; then
  echo "GPU index $MINERU_GPU_INDEX maps to $gpu_uuid, expected $MINERU_EXPECTED_GPU_UUID." >&2
  exit 4
fi

compute_processes="$(nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits 2>/dev/null || true)"
if printf '%s\n' "$compute_processes" | grep -Fq "$MINERU_EXPECTED_GPU_UUID"; then
  echo "GPU $MINERU_GPU_INDEX already has a compute process; refusing to share it:" >&2
  printf '%s\n' "$compute_processes" >&2
  exit 5
fi

gpu_used_mib="$(nvidia-smi -i "$MINERU_GPU_INDEX" --query-gpu=memory.used --format=csv,noheader,nounits | tr -d '[:space:]')"
if [[ ! "$gpu_used_mib" =~ ^[0-9]+$ ]] || (( gpu_used_mib > 1024 )); then
  echo "GPU $MINERU_GPU_INDEX baseline memory is ${gpu_used_mib:-unknown} MiB; refusing to start." >&2
  exit 5
fi

"$MINERU_VENV/bin/python" - "$MINERU_GPU_MEMORY_UTILIZATION" "$MINERU_TOOLS_CONFIG_JSON" <<'PY'
import json
import os
import sys
from pathlib import Path

utilization = float(sys.argv[1])
if not 0.1 <= utilization <= 0.5:
    raise SystemExit("GPU memory utilization must be between 0.1 and 0.5")

config_path = Path(sys.argv[2]).resolve(strict=True)
base = Path(os.environ["MINERU_BASE"]).resolve(strict=True)
config = json.loads(config_path.read_text(encoding="utf-8"))
for key in ("pipeline", "vlm"):
    value = config.get("models-dir", {}).get(key)
    if not value:
        raise SystemExit(f"models-dir.{key} is missing")
    model_path = Path(value).resolve(strict=True)
    try:
        model_path.relative_to(base)
    except ValueError as exc:
        raise SystemExit(f"model path escaped MINERU_BASE: {model_path}") from exc
if config.get("llm-aided-config", {}).get("title_aided", {}).get("enable"):
    raise SystemExit("LLM-aided title processing must remain disabled")
PY

available_kib="$(df -Pk "$MINERU_BASE" | awk 'NR == 2 {print $4}')"
if [[ ! "$available_kib" =~ ^[0-9]+$ ]] || (( available_kib < 10485760 )); then
  echo "At least 10 GiB of free space is required below $MINERU_BASE." >&2
  exit 6
fi

echo "preflight=passed gpu=$MINERU_GPU_INDEX uuid=$gpu_uuid baseline_mib=$gpu_used_mib"
