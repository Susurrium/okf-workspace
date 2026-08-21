#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
compose_file="${script_dir}/compose.yaml"
data_root="${MARKITDOWN_DATA_ROOT:-/srv/markitdown-data}"
token_file="${MARKITDOWN_TOKEN_FILE:-/etc/obsidian-markitdown/api-tokens.txt}"
host_port="${MARKITDOWN_HOST_PORT:-18010}"
service_uid="${MARKITDOWN_UID:-10002}"
service_gid="${MARKITDOWN_GID:-10002}"
expected_mount="${MARKITDOWN_EXPECTED_MOUNT:-}"
expected_source="${MARKITDOWN_EXPECTED_SOURCE:-}"
expected_fqdn="${MARKITDOWN_TAILNET_FQDN:-}"
expected_bundle_sha256="${MARKITDOWN_BUNDLE_MANIFEST_SHA256:-}"
runtime_release_sha256="${MARKITDOWN_RELEASE_MANIFEST_SHA256:-}"
require_runtime=false

usage() {
  echo "Usage: $0 [--data-root ABSOLUTE_PATH] [--token-file ABSOLUTE_PATH]" >&2
  echo "          [--host-port PORT] [--service-uid UID] [--service-gid GID]" >&2
  echo "          --expected-mount MOUNTPOINT --expected-source SOURCE" >&2
  echo "          --expected-tailnet-fqdn HOSTNAME" >&2
  echo "          --expected-bundle-manifest-sha256 SHA256" >&2
  echo "          --runtime-release-manifest-sha256 SHA256" >&2
  echo "          [--require-runtime]" >&2
}

fail() {
  echo "PRECHECK FAILED: $*" >&2
  exit 1
}

info() {
  echo "[ok] $*"
}

warn() {
  echo "[warning] $*" >&2
}

safe_absolute_path() {
  local value="$1"
  local label="$2"
  local canonical
  [[ "${value}" == /* ]] || fail "${label} must be an absolute path"
  [[ "${value}" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "${label} contains unsupported characters"
  canonical="$(realpath -m -- "${value}")" || fail "${label} cannot be canonicalized"
  [[ "${canonical}" == "${value%/}" ]] || \
    fail "${label} must be canonical and must not traverse symlinks: ${value}"
  case "${value%/}" in
    ""|/|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var)
      fail "${label} is too broad: ${value}"
      ;;
  esac
}

safe_mount_path() {
  local value="$1"
  local canonical
  [[ "${value}" == /* ]] || fail "expected mount must be an absolute path"
  [[ "${value}" =~ ^/[A-Za-z0-9._/-]*$ ]] || fail "expected mount contains unsupported characters"
  canonical="$(realpath -m -- "${value}")" || fail "expected mount cannot be canonicalized"
  [[ "${canonical}" == "${value%/}" || ( "${canonical}" == "/" && "${value}" == "/" ) ]] || \
    fail "expected mount must be canonical and must not traverse symlinks"
}

while (($#)); do
  case "$1" in
    --data-root)
      (($# >= 2)) || { usage; exit 2; }
      data_root="$2"
      shift 2
      ;;
    --token-file)
      (($# >= 2)) || { usage; exit 2; }
      token_file="$2"
      shift 2
      ;;
    --host-port)
      (($# >= 2)) || { usage; exit 2; }
      host_port="$2"
      shift 2
      ;;
    --service-uid)
      (($# >= 2)) || { usage; exit 2; }
      service_uid="$2"
      shift 2
      ;;
    --service-gid)
      (($# >= 2)) || { usage; exit 2; }
      service_gid="$2"
      shift 2
      ;;
    --expected-mount)
      (($# >= 2)) || { usage; exit 2; }
      expected_mount="$2"
      shift 2
      ;;
    --expected-source)
      (($# >= 2)) || { usage; exit 2; }
      expected_source="$2"
      shift 2
      ;;
    --expected-tailnet-fqdn)
      (($# >= 2)) || { usage; exit 2; }
      expected_fqdn="$2"
      shift 2
      ;;
    --expected-bundle-manifest-sha256)
      (($# >= 2)) || { usage; exit 2; }
      expected_bundle_sha256="$2"
      shift 2
      ;;
    --runtime-release-manifest-sha256)
      (($# >= 2)) || { usage; exit 2; }
      runtime_release_sha256="$2"
      shift 2
      ;;
    --require-runtime)
      require_runtime=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

safe_absolute_path "${data_root}" "data root"
safe_absolute_path "${token_file}" "token file"
[[ "${token_file}" == "/etc/obsidian-markitdown/api-tokens.txt" ]] || \
  fail "server token path must be /etc/obsidian-markitdown/api-tokens.txt"
[[ -n "${expected_mount}" && "${expected_mount}" != "REPLACE_ME" ]] || \
  fail "expected mount is required"
[[ -n "${expected_source}" && "${expected_source}" != "REPLACE_ME" ]] || \
  fail "expected filesystem source is required"
[[ "${expected_source}" =~ ^[-A-Za-z0-9_./:+,=@%]+$ ]] || \
  fail "expected filesystem source contains unsupported characters"
safe_mount_path "${expected_mount}"
expected_mount="${expected_mount%/}"
[[ -n "${expected_mount}" ]] || expected_mount="/"
if [[ "${expected_mount}" != "/" ]]; then
  case "${data_root}" in
    "${expected_mount}"|"${expected_mount}"/*) ;;
    *) fail "data root must be on or below the expected mount" ;;
  esac
fi
expected_fqdn="${expected_fqdn%.}"
[[ "${expected_fqdn}" =~ ^[a-z0-9-]+([.][a-z0-9-]+)+[.]ts[.]net$ ]] || \
  fail "expected Tailnet FQDN must be a lowercase *.ts.net hostname"
[[ "${expected_bundle_sha256}" =~ ^[0-9a-f]{64}$ ]] || \
  fail "expected bundle manifest SHA-256 is required"
[[ "${runtime_release_sha256}" =~ ^[0-9a-f]{64}$ ]] || \
  fail "runtime release manifest SHA-256 is required"
[[ "${host_port}" =~ ^[0-9]+$ ]] || fail "host port must be numeric"
((host_port >= 1024 && host_port <= 65535)) || fail "host port must be between 1024 and 65535"
[[ "${service_uid}" =~ ^[0-9]+$ ]] || fail "service UID must be numeric"
[[ "${service_gid}" =~ ^[0-9]+$ ]] || fail "service GID must be numeric"
((service_uid >= 1000 && service_uid <= 60000)) || fail "service UID is outside the allowed range"
((service_gid >= 1000 && service_gid <= 60000)) || fail "service GID is outside the allowed range"

for command_name in \
  awk cmp curl df docker find findmnt getent grep install mktemp mv nproc python3 \
  realpath sha256sum ss stat systemctl tailscale; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "required command is missing: ${command_name}"
done
info "required host commands are installed"

if [[ -x /usr/lib/systemd/systemd-socket-proxyd ]]; then
  proxy_binary=/usr/lib/systemd/systemd-socket-proxyd
elif [[ -x /lib/systemd/systemd-socket-proxyd ]]; then
  proxy_binary=/lib/systemd/systemd-socket-proxyd
else
  fail "systemd-socket-proxyd is unavailable"
fi
info "loopback proxy binary is available at ${proxy_binary}"

if getent passwd "${service_uid}" >/dev/null; then
  fail "service UID is already assigned to a host account: ${service_uid}"
fi
if getent group "${service_gid}" >/dev/null; then
  fail "service GID is already assigned to a host group: ${service_gid}"
fi
info "service UID/GID are not assigned to host identities"

[[ -r /etc/os-release ]] || fail "/etc/os-release is unavailable"
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] || \
  fail "this deployment is pinned to Ubuntu 24.04 (found ${PRETTY_NAME:-unknown})"
info "operating system is ${PRETTY_NAME}"

architecture="$(uname -m)"
[[ "${architecture}" == "x86_64" || "${architecture}" == "amd64" ]] || \
  fail "unsupported CPU architecture: ${architecture}"
info "CPU architecture is ${architecture}"

cpu_count="$(nproc)"
((cpu_count >= 2)) || fail "at least 2 CPU cores are required"
memory_kib="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
[[ "${memory_kib}" =~ ^[0-9]+$ ]] || fail "cannot determine total memory"
((memory_kib >= 3500000)) || fail "at least 4 GiB of host RAM is required"
info "host has at least 2 CPUs and approximately 4 GiB RAM"

docker info >/dev/null 2>&1 || fail "Docker daemon is not reachable by the current user"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is unavailable"
docker compose up --help 2>&1 | grep -q -- '--wait' || \
  fail "Docker Compose does not support health-gated up --wait"
info "Docker and Compose v2 are available"

tailscale_json="$(tailscale status --json 2>/dev/null)" || fail "Tailscale is not connected"
actual_fqdn="$(python3 -c '
import json
import sys
value = json.load(sys.stdin)
if value.get("BackendState") != "Running":
    raise SystemExit(1)
name = ((value.get("Self") or {}).get("DNSName") or "").rstrip(".")
if not name:
    raise SystemExit(1)
print(name)
' <<<"${tailscale_json}")" || fail "Tailscale backend is not running or has no DNS name"
[[ "${actual_fqdn}" == "${expected_fqdn}" ]] || \
  fail "Tailscale DNS name does not match (${actual_fqdn} != ${expected_fqdn})"
info "Tailscale is connected as ${actual_fqdn}"

actual_mount="$(findmnt --noheadings --raw --mountpoint "${expected_mount}" --output TARGET)" || \
  fail "expected mount is not currently mounted: ${expected_mount}"
actual_source="$(findmnt --noheadings --raw --mountpoint "${expected_mount}" --output SOURCE)" || \
  fail "cannot resolve source for expected mount: ${expected_mount}"
[[ "${actual_mount}" == "${expected_mount}" ]] || \
  fail "mounted target differs from the expected mount (${actual_mount})"
[[ "${actual_source}" == "${expected_source}" ]] || \
  fail "mounted source differs from the confirmed source (${actual_source} != ${expected_source})"
info "data mount and filesystem source match the confirmed values"

[[ -f "${compose_file}" ]] || fail "compose.yaml is missing beside this script"
[[ -f "${script_dir}/../../services/markitdown/Dockerfile" ]] || \
  fail "repository layout is incomplete: services/markitdown/Dockerfile is missing"
repository_root="$(cd -- "${script_dir}/../.." && pwd -P)"
bash "${script_dir}/verify-release.sh" "${repository_root}"
actual_release_sha256="$(sha256sum "${repository_root}/release-manifest.sha256" | awk '{print $1}')"
[[ "${actual_release_sha256}" == "${expected_bundle_sha256}" ]] || \
  fail "release manifest SHA-256 does not match the current bundle identity"
info "release file manifest and bundle identity are valid"
MARKITDOWN_DATA_ROOT="${data_root}" \
MARKITDOWN_TOKEN_FILE="${token_file}" \
MARKITDOWN_HOST_PORT="${host_port}" \
MARKITDOWN_UID="${service_uid}" \
MARKITDOWN_GID="${service_gid}" \
MARKITDOWN_RELEASE_MANIFEST_SHA256="${runtime_release_sha256}" \
  docker compose --project-directory "${script_dir}" -f "${compose_file}" config --quiet
MARKITDOWN_DATA_ROOT="${data_root}" \
MARKITDOWN_TOKEN_FILE="${token_file}" \
MARKITDOWN_HOST_PORT="${host_port}" \
MARKITDOWN_UID="${service_uid}" \
MARKITDOWN_GID="${service_gid}" \
MARKITDOWN_RELEASE_MANIFEST_SHA256="${runtime_release_sha256}" \
  python3 "${script_dir}/verify-compose.py"
info "Compose configuration is valid"

while IFS= read -r listener; do
  [[ -n "${listener}" ]] || continue
  case "${listener}" in
    "127.0.0.1:${host_port}"|"[::1]:${host_port}")
      info "existing listener on ${listener} is loopback-only"
      ;;
    *)
      fail "TCP ${host_port} is exposed by a non-loopback listener: ${listener}"
      ;;
  esac
done < <(ss -H -ltn | awk -v suffix=":${host_port}" '$4 ~ (suffix "$") {print $4}')

probe_path="${data_root}"
while [[ ! -e "${probe_path}" ]]; do
  parent_path="$(dirname -- "${probe_path}")"
  [[ "${parent_path}" != "${probe_path}" ]] || break
  probe_path="${parent_path}"
done
[[ -d "${probe_path}" ]] || fail "no existing parent directory for data root"
available_kib="$(df -Pk -- "${expected_mount}" | awk 'NR == 2 {print $4}')"
[[ "${available_kib}" =~ ^[0-9]+$ ]] || fail "cannot determine free space for ${probe_path}"
((available_kib >= 10485760)) || fail "data filesystem has less than 10 GiB free"
available_inodes="$(df -Pi -- "${expected_mount}" | awk 'NR == 2 {print $4}')"
[[ "${available_inodes}" =~ ^[0-9]+$ ]] || fail "cannot determine free inodes"
((available_inodes >= 100000)) || fail "data filesystem has fewer than 100000 free inodes"
info "data filesystem has at least 10 GiB and 100000 inodes free"
findmnt -M "${expected_mount}" -o TARGET,SOURCE,FSTYPE,OPTIONS --noheadings || \
  fail "cannot inspect the expected filesystem"

if [[ -e "${data_root}" ]]; then
  [[ ! -L "${data_root}" && -d "${data_root}" ]] || fail "data root is not a regular directory"
  info "data root exists and is not a symlink"
elif [[ "${require_runtime}" == true ]]; then
  fail "data root has not been initialized: ${data_root}"
else
  warn "data root does not exist yet; prepare-runtime.sh will create it"
fi

if [[ -e "${token_file}" ]]; then
  [[ ! -L "${token_file}" && -f "${token_file}" ]] || fail "token path is not a regular file"
  token_mode="$(stat -c '%a' -- "${token_file}")"
  token_uid="$(stat -c '%u' -- "${token_file}")"
  token_gid="$(stat -c '%g' -- "${token_file}")"
  token_mode_value=$((8#${token_mode}))
  (( (token_mode_value & 0007) == 0 )) || fail "token file grants permissions to other users"
  service_can_read=false
  if [[ "${token_uid}" == "${service_uid}" ]] && (( (token_mode_value & 0400) != 0 )); then
    service_can_read=true
  fi
  if [[ "${token_gid}" == "${service_gid}" ]] && (( (token_mode_value & 0040) != 0 )); then
    service_can_read=true
  fi
  [[ "${service_can_read}" == true ]] || fail "container UID/GID cannot read the token file"
  awk '
    /^[[:space:]]*(#|$)/ { next }
    { sub(/\r$/, ""); count += 1; if (length($0) < 32) bad = 1 }
    END { exit !(count >= 1 && bad != 1) }
  ' "${token_file}" || fail "token file has no valid active token"
  info "token file is permission-restricted and contains a valid token"
elif [[ "${require_runtime}" == true ]]; then
  fail "token file has not been installed: ${token_file}"
else
  warn "token file does not exist yet; prepare-runtime.sh must install it"
fi

if [[ "${require_runtime}" == true ]]; then
  ((EUID == 0)) || fail "runtime preflight must run through sudo"
  marker_file="${data_root}/.obsidian-markitdown-data-v1"
  [[ -f "${marker_file}" && ! -L "${marker_file}" ]] || \
    fail "data-root ownership marker is missing or unsafe"
  [[ "$(stat -c '%u:%g:%a' -- "${marker_file}")" == "0:0:600" ]] || \
    fail "data-root ownership marker permissions are invalid"
  [[ "$(<"${marker_file}")" == "obsidian-markitdown-data/v1" ]] || \
    fail "data-root ownership marker content is invalid"
  for runtime_dir in "${data_root}" "${data_root}/state" "${data_root}/spool"; do
    [[ ! -L "${runtime_dir}" && -d "${runtime_dir}" ]] || fail "runtime directory is invalid: ${runtime_dir}"
    [[ "$(stat -c '%u' -- "${runtime_dir}")" == "${service_uid}" ]] || \
      fail "runtime directory owner UID is incorrect: ${runtime_dir}"
    [[ "$(stat -c '%g' -- "${runtime_dir}")" == "${service_gid}" ]] || \
      fail "runtime directory owner GID is incorrect: ${runtime_dir}"
    [[ "$(stat -c '%a' -- "${runtime_dir}")" == "700" ]] || \
      fail "runtime directory mode must be 700: ${runtime_dir}"
  done
  info "runtime directories have the expected numeric ownership and mode"
fi

echo "Preflight completed without changing host state."
