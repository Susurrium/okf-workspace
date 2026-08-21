#!/usr/bin/env bash
set -euo pipefail

((EUID == 0)) || {
  echo "Run smoke-test.sh through sudo to read the protected server token." >&2
  exit 1
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "${script_dir}"

env_value() {
  local key="$1"
  [[ -f .env && ! -L .env ]] || return 0
  awk -F= -v key="${key}" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' .env
}

base_url="${MARKITDOWN_BASE_URL:-http://127.0.0.1:$(env_value MARKITDOWN_HOST_PORT)}"
token_file="${MARKITDOWN_TOKEN_FILE:-$(env_value MARKITDOWN_TOKEN_FILE)}"
build_id="${MARKITDOWN_ENGINE_BUILD_ID:-$(env_value MARKITDOWN_ENGINE_BUILD_ID)}"
release_manifest_sha256="${MARKITDOWN_RELEASE_MANIFEST_SHA256:-$(env_value MARKITDOWN_RELEASE_MANIFEST_SHA256)}"
pdf_path="${1:-}"

arguments=(
  --base-url "${base_url}"
  --token-file "${token_file}"
  --expected-build-id "${build_id}"
  --expected-release-manifest-sha256 "${release_manifest_sha256}"
  --health-timeout 30
)
if [[ -n "${pdf_path}" ]]; then
  arguments+=(--pdf "${pdf_path}")
fi
exec python3 ./verify.py "${arguments[@]}"
