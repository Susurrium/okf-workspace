#!/usr/bin/env bash
set -euo pipefail
umask 077

managed_marker="# Managed by obsidian-markitdown-fallback"
socket_unit="obsidian-markitdown-proxy.socket"
service_unit="obsidian-markitdown-proxy.service"
unit_directory="/etc/systemd/system"
socket_path="${unit_directory}/${socket_unit}"
service_path="${unit_directory}/${service_unit}"

fail() {
  echo "PROXY CONFIGURATION FAILED: $*" >&2
  exit 1
}

((EUID == 0)) || fail "run this script through sudo"
(($# == 0)) || fail "this script does not accept arguments"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "${script_dir}"

[[ -f .env && ! -L .env ]] || fail "missing safe .env"
[[ -f ./verify-runtime-topology.py && ! -L ./verify-runtime-topology.py ]] || \
  fail "verify-runtime-topology.py is missing or unsafe"
[[ -d "${unit_directory}" && ! -L "${unit_directory}" ]] || \
  fail "systemd unit directory is missing or unsafe"

env_value_from_file() {
  local file="$1"
  local key="$2"
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
  ' "${file}"
}

host_port="$(env_value_from_file .env MARKITDOWN_HOST_PORT)" || \
  fail ".env must contain exactly one MARKITDOWN_HOST_PORT"
[[ "${host_port}" =~ ^[1-9][0-9]{3,4}$ ]] || \
  fail "MARKITDOWN_HOST_PORT must be a canonical decimal port from 1024 through 65535"
host_port_number=$((10#${host_port}))
((host_port_number >= 1024 && host_port_number <= 65535)) || \
  fail "MARKITDOWN_HOST_PORT must be from 1024 through 65535"

api_ip="$(python3 ./verify-runtime-topology.py --print-api-ip)" || \
  fail "runtime topology verification failed"
python3 - "${api_ip}" <<'PY' || fail "topology verifier did not return one canonical IPv4 address"
import ipaddress
import sys

if len(sys.argv) != 2:
    raise SystemExit(1)
value = sys.argv[1]
try:
    address = ipaddress.IPv4Address(value)
except ipaddress.AddressValueError:
    raise SystemExit(1)
if (
    str(address) != value
    or address.is_unspecified
    or address.is_multicast
    or address.is_loopback
    or address.is_link_local
):
    raise SystemExit(1)
PY

proxyd_path=""
for candidate in \
  /usr/lib/systemd/systemd-socket-proxyd \
  /lib/systemd/systemd-socket-proxyd; do
  if [[ -x "${candidate}" ]]; then
    proxyd_path="${candidate}"
    break
  fi
done
[[ -n "${proxyd_path}" ]] || fail "systemd-socket-proxyd is unavailable"

assert_managed_or_absent() {
  local path="$1"
  if [[ -L "${path}" ]]; then
    fail "refusing to replace a symlinked unit: ${path}"
  fi
  if [[ -e "${path}" ]]; then
    [[ -f "${path}" ]] || fail "unit path is not a regular file: ${path}"
    grep -Fqx -- "${managed_marker}" "${path}" || \
      fail "refusing to replace an unmanaged unit: ${path}"
  fi
}

assert_managed_or_absent "${socket_path}"
assert_managed_or_absent "${service_path}"
for drop_in_path in "${socket_path}.d" "${service_path}.d"; do
  [[ ! -e "${drop_in_path}" && ! -L "${drop_in_path}" ]] || \
    fail "refusing a unit with unsupported drop-ins: ${drop_in_path}"
done

socket_tmp=""
service_tmp=""
cleanup() {
  [[ -z "${socket_tmp:-}" ]] || rm -f -- "${socket_tmp}"
  [[ -z "${service_tmp:-}" ]] || rm -f -- "${service_tmp}"
}
trap cleanup EXIT
socket_tmp="$(mktemp --tmpdir="${unit_directory}" .obsidian-markitdown-proxy.socket.XXXXXX)"
service_tmp="$(mktemp --tmpdir="${unit_directory}" .obsidian-markitdown-proxy.service.XXXXXX)"

cat >"${socket_tmp}" <<EOF
${managed_marker}
[Unit]
Description=Obsidian MarkItDown loopback proxy socket
PartOf=obsidian-markitdown.service

[Socket]
ListenStream=127.0.0.1:${host_port}
Accept=no
NoDelay=true
Service=${service_unit}
EOF

cat >"${service_tmp}" <<EOF
${managed_marker}
[Unit]
Description=Obsidian MarkItDown loopback proxy
PartOf=obsidian-markitdown.service
Requires=${socket_unit}
After=docker.service ${socket_unit}

[Service]
Type=exec
DynamicUser=yes
ExecStart=${proxyd_path} --connections-max=32 ${api_ip}:8080
UMask=0077
NoNewPrivileges=yes
PrivateDevices=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectClock=yes
ProtectControlGroups=yes
ProtectHostname=yes
ProtectKernelLogs=yes
ProtectKernelModules=yes
ProtectKernelTunables=yes
ProtectProc=invisible
ProcSubset=pid
RestrictAddressFamilies=AF_INET
IPAddressDeny=any
IPAddressAllow=127.0.0.0/8
IPAddressAllow=${api_ip}/32
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
Restart=on-failure
RestartSec=1s
EOF

chown root:root -- "${socket_tmp}" "${service_tmp}"
chmod 0644 -- "${socket_tmp}" "${service_tmp}"

stop_exact_unit() {
  local unit="$1"
  local load_state
  load_state="$(systemctl show --property=LoadState --value "${unit}" 2>/dev/null || true)"
  if [[ -n "${load_state}" && "${load_state}" != "not-found" ]]; then
    systemctl stop "${unit}"
  fi
  if systemctl is-active --quiet "${unit}"; then
    fail "could not stop ${unit}"
  fi
}

# Stop accepting new connections before terminating any active proxy process.
stop_exact_unit "${socket_unit}"
stop_exact_unit "${service_unit}"

# Recheck immediately before the atomic replacements.
assert_managed_or_absent "${socket_path}"
assert_managed_or_absent "${service_path}"
mv -fT -- "${service_tmp}" "${service_path}"
service_tmp=""
mv -fT -- "${socket_tmp}" "${socket_path}"
socket_tmp=""

systemctl daemon-reload
# A freshly installed static unit has no loaded/failed state yet.  systemctl
# returns non-zero for that benign first-install case, so reset only when a
# failed state exists and let the following start remain the authoritative gate.
systemctl reset-failed "${socket_unit}" "${service_unit}" >/dev/null 2>&1 || true
systemctl start "${socket_unit}"
systemctl is-active --quiet "${socket_unit}" || fail "${socket_unit} did not become active"

listener_output="$(ss -H -ltn "sport = :${host_port}")" || \
  fail "cannot inspect the loopback proxy listener"
[[ -n "${listener_output}" ]] || fail "no TCP listener exists on port ${host_port}"
mapfile -t listener_addresses < <(awk '{print $4}' <<<"${listener_output}")
[[ "${#listener_addresses[@]}" -eq 1 \
  && "${listener_addresses[0]}" == "127.0.0.1:${host_port}" ]] || {
  printf 'Unexpected TCP listeners on port %s:\n%s\n' "${host_port}" "${listener_output}" >&2
  fail "the proxy port must have exactly one 127.0.0.1 listener"
}

trap - EXIT
echo "Loopback proxy socket is active on 127.0.0.1:${host_port} for ${api_ip}:8080."
