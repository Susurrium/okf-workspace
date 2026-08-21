#!/usr/bin/env bash
set -euo pipefail

((EUID == 0)) || {
  echo "Run status.sh through sudo." >&2
  exit 1
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "${script_dir}"

docker compose ps
python3 ./verify-runtime-topology.py
systemctl is-active --quiet obsidian-markitdown-proxy.socket || {
  echo "Loopback proxy socket is not active." >&2
  exit 1
}
bash ./smoke-test.sh
