#!/usr/bin/env bash

# This file is sourced by every deployment command. Do not put secrets here.

# Server policy: every sizeable deployment artifact must remain below
# ~/workdir.  These identity and bind settings are deliberately not
# environment-overridable; changing them requires reviewing this deployment.
export MINERU_WORKDIR_ROOT="$HOME/workdir"
export MINERU_BASE="$MINERU_WORKDIR_ROOT/mineru"
export MINERU_VENV="$MINERU_BASE/venv"
export MINERU_CONFIG_DIR="$MINERU_BASE/config"
export MINERU_MODELS_DIR="$MINERU_BASE/models"
export MINERU_CACHE_DIR="$MINERU_BASE/cache"
export MINERU_TMP_DIR="$MINERU_BASE/tmp"
export MINERU_JOBS_DIR="$MINERU_BASE/jobs"
export MINERU_LOG_DIR="$MINERU_BASE/logs"
export MINERU_RUN_DIR="$MINERU_BASE/run"
export MINERU_SYSROOT="$MINERU_BASE/sysroot"

# Keep package, model, compilation, and runtime caches out of the home root.
export XDG_CACHE_HOME="$MINERU_CACHE_DIR/xdg"
export XDG_CONFIG_HOME="$MINERU_CONFIG_DIR/xdg"
export XDG_DATA_HOME="$MINERU_BASE/data/xdg"
export PIP_CACHE_DIR="$MINERU_CACHE_DIR/pip"
export UV_CACHE_DIR="$MINERU_CACHE_DIR/uv"
export MODELSCOPE_CACHE="$MINERU_MODELS_DIR/modelscope"
export HF_HOME="$MINERU_MODELS_DIR/huggingface"
export HUGGINGFACE_HUB_CACHE="$HF_HOME/hub"
export HF_XET_CACHE="$HF_HOME/xet"
export HF_ASSETS_CACHE="$HF_HOME/assets"
export HF_DATASETS_CACHE="$HF_HOME/datasets"
export TORCH_HOME="$MINERU_CACHE_DIR/torch"
export TORCH_EXTENSIONS_DIR="$MINERU_CACHE_DIR/torch-extensions"
export TORCHINDUCTOR_CACHE_DIR="$MINERU_CACHE_DIR/torchinductor"
export TRITON_CACHE_DIR="$MINERU_CACHE_DIR/triton"
export CUDA_CACHE_PATH="$MINERU_CACHE_DIR/cuda"
export NUMBA_CACHE_DIR="$MINERU_CACHE_DIR/numba"
export MPLCONFIGDIR="$MINERU_CACHE_DIR/matplotlib"
export PYTHONPYCACHEPREFIX="$MINERU_CACHE_DIR/pycache"
export VLLM_CACHE_ROOT="$MINERU_CACHE_DIR/vllm"
export VLLM_CONFIG_ROOT="$MINERU_CONFIG_DIR/vllm"
export VLLM_RPC_BASE_PATH="$MINERU_RUN_DIR/vllm-rpc"
export TMPDIR="$MINERU_TMP_DIR"
export TMP="$MINERU_TMP_DIR"
export TEMP="$MINERU_TMP_DIR"
export JOBLIB_TEMP_FOLDER="$MINERU_TMP_DIR/joblib"

# Ubuntu's minimal Python installation omits Python.h. Triton compiles a tiny
# runtime helper on first use, so user-scoped headers are exposed through GCC's
# standard search variables without modifying /usr.
mineru_prepend_path_once() {
  local variable_name="$1"
  local entry="$2"
  local current="${!variable_name:-}"
  case ":$current:" in
    *":$entry:"*) ;;
    *) printf -v "$variable_name" '%s' "$entry${current:+:$current}" ;;
  esac
  export "$variable_name"
}
mineru_prepend_path_once CPATH "$MINERU_SYSROOT/usr/include/python3.12"
mineru_prepend_path_once CPATH "$MINERU_SYSROOT/usr/include"
mineru_prepend_path_once LIBRARY_PATH "$MINERU_SYSROOT/usr/lib/x86_64-linux-gnu"
unset -f mineru_prepend_path_once

export MINERU_TOOLS_CONFIG_JSON="$MINERU_CONFIG_DIR/mineru.json"
export MINERU_API_OUTPUT_ROOT="$MINERU_JOBS_DIR/output"
export MINERU_MODEL_SOURCE=local

# vLLM 0.11.2 requires CUDA_VISIBLE_DEVICES to contain a numeric index. The
# lifecycle script verifies that this index still maps to the expected UUID
# before starting, so a topology change cannot silently select GPU 1.
export CUDA_DEVICE_ORDER=PCI_BUS_ID
export MINERU_GPU_INDEX=0
export MINERU_EXPECTED_GPU_UUID=GPU-5a1f2ba5-bbb7-9e1e-c142-21abc5783319
export CUDA_VISIBLE_DEVICES="$MINERU_GPU_INDEX"
export MINERU_DEVICE_MODE=cuda

export MINERU_API_MAX_CONCURRENT_REQUESTS="${MINERU_API_MAX_CONCURRENT_REQUESTS:-1}"
export MINERU_PROCESSING_WINDOW_SIZE="${MINERU_PROCESSING_WINDOW_SIZE:-64}"
export MINERU_PDF_RENDER_THREADS="${MINERU_PDF_RENDER_THREADS:-4}"
export MINERU_PDF_RENDER_TIMEOUT="${MINERU_PDF_RENDER_TIMEOUT:-300}"
export MINERU_API_TASK_RETENTION_SECONDS="${MINERU_API_TASK_RETENTION_SECONDS:-86400}"
export MINERU_API_TASK_CLEANUP_INTERVAL_SECONDS="${MINERU_API_TASK_CLEANUP_INTERVAL_SECONDS:-300}"
export MINERU_API_ENABLE_FASTAPI_DOCS="${MINERU_API_ENABLE_FASTAPI_DOCS:-false}"
export MINERU_API_DISABLE_ACCESS_LOG="${MINERU_API_DISABLE_ACCESS_LOG:-true}"
export MINERU_FORMULA_ENABLE=true
export MINERU_TABLE_ENABLE=true
export MINERU_TABLE_MERGE_ENABLE=true

export TOKENIZERS_PARALLELISM=false
export PYTHONUNBUFFERED=1
export PYTORCH_ALLOC_CONF=expandable_segments:True
export VLLM_NO_USAGE_STATS=1
# vLLM otherwise auto-detects the server's routable address for its internal
# PyTorch distributed store. This deployment is single-node/single-GPU, so all
# engine coordination must remain on loopback as well as the HTTP API.
export VLLM_HOST_IP=127.0.0.1
export VLLM_LOOPBACK_IP=127.0.0.1
export MASTER_ADDR=127.0.0.1
export GLOO_SOCKET_IFNAME=lo
export NCCL_SOCKET_IFNAME=lo
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1

export MINERU_API_HOST=127.0.0.1
export MINERU_API_PORT=8000
export MINERU_GPU_MEMORY_UTILIZATION="${MINERU_GPU_MEMORY_UTILIZATION:-0.25}"
export MINERU_ORPHAN_RETENTION_MINUTES="${MINERU_ORPHAN_RETENTION_MINUTES:-2880}"
export MINERU_LOG_RETENTION_DAYS="${MINERU_LOG_RETENTION_DAYS:-14}"
export MINERU_LOG_RETAIN_COUNT="${MINERU_LOG_RETAIN_COUNT:-12}"
