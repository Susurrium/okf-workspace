#!/usr/bin/env bash
set -euo pipefail
umask 077

((EUID == 0)) || {
  echo "Run install-systemd.sh through sudo." >&2
  exit 1
}

replace_unit=false
if [[ "${1:-}" == "--replace" ]]; then
  replace_unit=true
  shift
fi
if (($#)); then
  echo "Usage: sudo bash install-systemd.sh [--replace]" >&2
  exit 2
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "${script_dir}/../.." && pwd -P)"
[[ "${script_dir}" =~ ^/[A-Za-z0-9._/-]+$ ]] || {
  echo "Deployment path contains unsupported characters." >&2
  exit 1
}
cd "${script_dir}"

env_value() {
  local key="$1"
  awk -F= -v key="${key}" '
    $1 == key {
      count += 1
      sub(/^[^=]*=/, "")
      value = $0
    }
    END {
      if (count != 1) exit 2
      print value
    }
  ' .env
}

[[ -f .env && ! -L .env ]] || {
  echo "Missing safe .env." >&2
  exit 1
}
expected_mount="$(env_value MARKITDOWN_EXPECTED_MOUNT)"
data_root="$(env_value MARKITDOWN_DATA_ROOT)"
token_file="$(env_value MARKITDOWN_TOKEN_FILE)"
for value in "${expected_mount}" "${data_root}" "${token_file}"; do
  [[ "${value}" == /* && "${value}" =~ ^/[A-Za-z0-9._/-]*$ ]] || {
    echo "Runtime path in .env is unsafe: ${value}" >&2
    exit 1
  }
  canonical_value="$(realpath -m -- "${value}")"
  [[ "${canonical_value}" == "${value%/}" || ( "${canonical_value}" == "/" && "${value}" == "/" ) ]] || {
    echo "Runtime path in .env is not canonical or traverses a symlink: ${value}" >&2
    exit 1
  }
done

unit_path="/etc/systemd/system/obsidian-markitdown.service"
[[ ! -L "${unit_path}" ]] || {
  echo "Refusing to replace a symlinked systemd unit." >&2
  exit 1
}
unit_tmp="$(mktemp)"
cleanup() {
  rm -f -- "${unit_tmp}"
}
trap cleanup EXIT
cat >"${unit_tmp}" <<EOF
[Unit]
Description=Obsidian MarkItDown fallback service
Requires=docker.service
After=network-online.target docker.service tailscaled.service obsidian-markitdown-proxy.socket
Wants=network-online.target tailscaled.service obsidian-markitdown-proxy.socket
PartOf=docker.service
RequiresMountsFor=${expected_mount}
ConditionPathIsDirectory=${data_root}/state
ConditionPathIsDirectory=${data_root}/spool
ConditionFileNotEmpty=${data_root}/.obsidian-markitdown-data-v1
ConditionFileNotEmpty=${token_file}
ConditionFileNotEmpty=${repository_root}/release-manifest.sha256
ConditionFileNotEmpty=${script_dir}/.current-release
ConditionFileNotEmpty=${script_dir}/.current-release.env
ConditionFileNotEmpty=${script_dir}/configure-loopback-proxy.sh
ConditionFileNotEmpty=${script_dir}/reconcile-runtime-mount.sh
ConditionFileNotEmpty=${script_dir}/verify-runtime-topology.py

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${script_dir}
ExecStartPre=/usr/bin/bash ${script_dir}/reconcile-runtime-mount.sh
ExecStart=/usr/bin/bash ${script_dir}/start.sh
ExecStop=/usr/bin/docker compose stop
Restart=on-failure
RestartSec=30s
TimeoutStartSec=300
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "${unit_tmp}"

if [[ -f "${unit_path}" ]] && ! cmp -s -- "${unit_tmp}" "${unit_path}"; then
  if [[ "${replace_unit}" != true ]]; then
    echo "Existing systemd unit differs; inspect it and rerun with --replace." >&2
    exit 1
  fi
  backup_path="$(mktemp /etc/systemd/system/obsidian-markitdown.service.backup-XXXXXXXXXX)"
  install -m 0600 -- "${unit_path}" "${backup_path}"
  echo "Previous unit preserved at ${backup_path}."
fi
install -o root -g root -m 0644 -- "${unit_tmp}" "${unit_path}"
systemctl daemon-reload
systemctl enable obsidian-markitdown.service
if ! systemctl is-active --quiet obsidian-markitdown.service; then
  systemctl start obsidian-markitdown.service
fi
systemctl --no-pager --full status obsidian-markitdown.service
