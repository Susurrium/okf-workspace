#!/usr/bin/env bash

# Shared safety checks for the bjmu-inner deployment.  This file is sourced;
# callers remain responsible for set -euo pipefail and a private umask.

mineru_validate_base() {
  local expected="$HOME/workdir/mineru"
  if [[ "$MINERU_BASE" != "$expected" ]]; then
    echo "MINERU_BASE must be exactly $expected" >&2
    return 2
  fi

  install -d -m 0700 "$MINERU_WORKDIR_ROOT" "$MINERU_BASE"
  local workdir_real base_real
  workdir_real="$(realpath -e -- "$MINERU_WORKDIR_ROOT")"
  base_real="$(realpath -e -- "$MINERU_BASE")"
  case "$base_real/" in
    "$workdir_real"/*) ;;
    *)
      echo "MINERU_BASE resolves outside ~/workdir: $base_real" >&2
      return 2
      ;;
  esac
  if [[ "$base_real" == "$workdir_real" ]]; then
    echo "MINERU_BASE must be a child of ~/workdir, not the root itself." >&2
    return 2
  fi
}

mineru_ensure_runtime_dirs() {
  mineru_validate_base
  install -d -m 0700 \
    "$MINERU_CONFIG_DIR" \
    "$XDG_DATA_HOME" \
    "$MINERU_MODELS_DIR" \
    "$MINERU_CACHE_DIR" \
    "$XDG_CACHE_HOME/torch/kernels" \
    "$XDG_CONFIG_HOME" \
    "$TORCH_EXTENSIONS_DIR" \
    "$TORCHINDUCTOR_CACHE_DIR" \
    "$TRITON_CACHE_DIR" \
    "$CUDA_CACHE_PATH" \
    "$NUMBA_CACHE_DIR" \
    "$MPLCONFIGDIR" \
    "$PYTHONPYCACHEPREFIX" \
    "$VLLM_CACHE_ROOT" \
    "$VLLM_CONFIG_ROOT" \
    "$VLLM_RPC_BASE_PATH" \
    "$MINERU_TMP_DIR" \
    "$MINERU_JOBS_DIR/incoming" \
    "$MINERU_JOBS_DIR/working" \
    "$MINERU_JOBS_DIR/output" \
    "$MINERU_JOBS_DIR/failed" \
    "$MINERU_LOG_DIR" \
    "$MINERU_RUN_DIR" \
    "$MINERU_SYSROOT" \
    "$JOBLIB_TEMP_FOLDER"
}

mineru_is_port_listening() {
  ss -H -ltn "sport = :$MINERU_API_PORT" 2>/dev/null | grep -q .
}
