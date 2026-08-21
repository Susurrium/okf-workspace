#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
data_root="/srv/markitdown-data"
token_file="/etc/obsidian-markitdown/api-tokens.txt"
token_source=""
host_port="18010"
service_uid="10002"
service_gid="10002"
expected_mount=""
expected_source=""
expected_fqdn=""
bundle_manifest_sha256=""
runtime_release_sha256=""
replace_token=false
replace_config=false

while IFS= read -r variable_name; do
  if [[ "${variable_name}" == MARKITDOWN_* ]]; then
    echo "Pass reviewed runtime values as explicit arguments, not environment overrides: ${variable_name}" >&2
    exit 1
  fi
done < <(compgen -e)

usage() {
  echo "Usage: sudo $0 [--data-root ABSOLUTE_PATH] [--token-file ABSOLUTE_PATH]" >&2
  echo "          [--token-source FILE] [--replace-token] [--host-port PORT]" >&2
  echo "          [--service-uid UID] [--service-gid GID]" >&2
  echo "          --expected-mount MOUNTPOINT --expected-source SOURCE" >&2
  echo "          --expected-tailnet-fqdn HOSTNAME [--replace-config]" >&2
}

fail() {
  echo "PREPARE FAILED: $*" >&2
  exit 1
}

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
    --token-source)
      (($# >= 2)) || { usage; exit 2; }
      token_source="$2"
      shift 2
      ;;
    --replace-token)
      replace_token=true
      shift
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
    --replace-config)
      replace_config=true
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

((EUID == 0)) || fail "run this script through sudo"
safe_absolute_path "${data_root}" "data root"
safe_absolute_path "${token_file}" "token file"
[[ "${token_file}" == "/etc/obsidian-markitdown/api-tokens.txt" ]] || \
  fail "server token path must be /etc/obsidian-markitdown/api-tokens.txt"
[[ -n "${expected_mount}" && "${expected_mount}" != "REPLACE_ME" ]] || fail "expected mount is required"
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
[[ "${host_port}" =~ ^[0-9]+$ ]] || fail "host port must be numeric"
((host_port >= 1024 && host_port <= 65535)) || fail "host port is outside the allowed range"
[[ "${service_uid}" =~ ^[0-9]+$ && "${service_gid}" =~ ^[0-9]+$ ]] || \
  fail "service UID and GID must be numeric"
((service_uid >= 1000 && service_uid <= 60000)) || fail "service UID is outside the allowed range"
((service_gid >= 1000 && service_gid <= 60000)) || fail "service GID is outside the allowed range"
[[ -f "${script_dir}/.env.example" && ! -L "${script_dir}/.env.example" ]] || \
  fail ".env.example is missing or unsafe"

repository_root="$(cd -- "${script_dir}/../.." && pwd -P)"
bash "${script_dir}/verify-release.sh" "${repository_root}"
bundle_manifest_sha256="$(sha256sum "${repository_root}/release-manifest.sha256" | awk '{print $1}')"
[[ "${bundle_manifest_sha256}" =~ ^[0-9a-f]{64}$ ]] || fail "bundle manifest digest is invalid"

environment_file="${script_dir}/.env"
if [[ -L "${environment_file}" ]]; then
  fail ".env must not be a symlink"
fi
runtime_release_sha256="${bundle_manifest_sha256}"
if [[ -f "${environment_file}" && "${replace_config}" != true ]]; then
  runtime_release_sha256="$(
    env_value_from_file "${environment_file}" MARKITDOWN_RELEASE_MANIFEST_SHA256
  )" || fail "existing .env must contain exactly one runtime release identity"
  [[ "${runtime_release_sha256}" =~ ^[0-9a-f]{64}$ ]] || \
    fail "existing runtime release manifest digest is invalid"
fi

bash "${script_dir}/preflight.sh" \
  --data-root "${data_root}" \
  --token-file "${token_file}" \
  --host-port "${host_port}" \
  --service-uid "${service_uid}" \
  --service-gid "${service_gid}" \
  --expected-mount "${expected_mount}" \
  --expected-source "${expected_source}" \
  --expected-tailnet-fqdn "${expected_fqdn}" \
  --expected-bundle-manifest-sha256 "${bundle_manifest_sha256}" \
  --runtime-release-manifest-sha256 "${runtime_release_sha256}"

if [[ -f "${environment_file}" && "${replace_config}" != true ]]; then
  for expected_pair in \
    "MARKITDOWN_DATA_ROOT=${data_root}" \
    "MARKITDOWN_TOKEN_FILE=${token_file}" \
    "MARKITDOWN_HOST_PORT=${host_port}" \
    "MARKITDOWN_UID=${service_uid}" \
    "MARKITDOWN_GID=${service_gid}" \
    "MARKITDOWN_EXPECTED_MOUNT=${expected_mount}" \
    "MARKITDOWN_EXPECTED_SOURCE=${expected_source}" \
    "MARKITDOWN_TAILNET_FQDN=${expected_fqdn}" \
    "MARKITDOWN_BUNDLE_MANIFEST_SHA256=${bundle_manifest_sha256}" \
    "MARKITDOWN_RELEASE_MANIFEST_SHA256=${runtime_release_sha256}"; do
    expected_key="${expected_pair%%=*}"
    expected_value="${expected_pair#*=}"
    actual_value="$(env_value_from_file "${environment_file}" "${expected_key}")" || \
      fail "existing .env must contain exactly one ${expected_key}"
    [[ "${actual_value}" == "${expected_value}" ]] || \
      fail "existing .env differs in ${expected_key}; use --replace-config only after review"
  done
fi

actual_mount="$(findmnt --noheadings --raw --mountpoint "${expected_mount}" --output TARGET)" || \
  fail "expected mount is not currently mounted: ${expected_mount}"
actual_source="$(findmnt --noheadings --raw --mountpoint "${expected_mount}" --output SOURCE)" || \
  fail "cannot resolve source for expected mount: ${expected_mount}"
[[ "${actual_mount}" == "${expected_mount}" && "${actual_source}" == "${expected_source}" ]] || \
  fail "mounted target/source does not match the confirmed data filesystem"

marker_file="${data_root}/.obsidian-markitdown-data-v1"
if [[ -e "${data_root}" && ! -e "${marker_file}" ]]; then
  unexpected_entry="$(find "${data_root}" -mindepth 1 -maxdepth 1 ! -name lost+found -print -quit)"
  [[ -z "${unexpected_entry}" ]] || \
    fail "unmarked data root is not empty; refusing to take ownership: ${unexpected_entry}"
fi

if [[ -e "${data_root}" ]]; then
  [[ ! -L "${data_root}" && -d "${data_root}" ]] || fail "data root is not a regular directory"
fi
install -d -o "${service_uid}" -g "${service_gid}" -m 0700 -- "${data_root}"
for runtime_dir in state spool; do
  target="${data_root}/${runtime_dir}"
  if [[ -e "${target}" ]]; then
    [[ ! -L "${target}" && -d "${target}" ]] || fail "runtime path is not a regular directory: ${target}"
  fi
  install -d -o "${service_uid}" -g "${service_gid}" -m 0700 -- "${target}"
done
if [[ -e "${marker_file}" ]]; then
  [[ -f "${marker_file}" && ! -L "${marker_file}" ]] || fail "data-root marker is unsafe"
  [[ "$(<"${marker_file}")" == "obsidian-markitdown-data/v1" ]] || \
    fail "data-root marker belongs to an unsupported layout"
else
  marker_tmp="$(mktemp)"
  printf '%s\n' 'obsidian-markitdown-data/v1' >"${marker_tmp}"
  install -o root -g root -m 0600 -- "${marker_tmp}" "${marker_file}"
  rm -f -- "${marker_tmp}"
fi
chown root:root -- "${marker_file}"
chmod 0600 -- "${marker_file}"

if [[ -n "${token_source}" ]]; then
  [[ "${token_source}" == /* ]] || fail "token source must be an absolute path"
  [[ -f "${token_source}" && ! -L "${token_source}" ]] || fail "token source is not a regular file"
  token_source_canonical="$(realpath -e -- "${token_source}")" || fail "token source cannot be resolved"
  [[ "${token_source_canonical}" == "${token_source}" ]] || \
    fail "token source must be canonical and must not traverse symlinks"
  source_uid="$(stat -c '%u' -- "${token_source}")"
  [[ "${source_uid}" == "0" || "${source_uid}" == "${SUDO_UID:-0}" ]] || \
    fail "token source must be owned by root or the sudo caller"
  source_mode_value=$((8#$(stat -c '%a' -- "${token_source}")))
  (( (source_mode_value & 0077) == 0 )) || \
    fail "token source must not grant permissions to group or other users"
  awk '
    /^[[:space:]]*(#|$)/ { next }
    { sub(/\r$/, ""); count += 1; if (length($0) < 32) bad = 1 }
    END { exit !(count == 1 && bad != 1) }
  ' "${token_source}" || fail "token source must contain exactly one active token of at least 32 characters"
  if [[ -e "${token_file}" ]]; then
    [[ -f "${token_file}" && ! -L "${token_file}" ]] || fail "existing token target is unsafe"
    if ! cmp -s -- "${token_source}" "${token_file}" && [[ "${replace_token}" != true ]]; then
      fail "token target already differs; pass --replace-token only for an intentional rotation"
    fi
  fi
  install -d -o root -g "${service_gid}" -m 0750 -- "$(dirname -- "${token_file}")"
  install -o root -g "${service_gid}" -m 0640 -- "${token_source}" "${token_file}"
elif [[ ! -f "${token_file}" || -L "${token_file}" ]]; then
  fail "supply --token-source for the initial deployment"
fi
chown root:"${service_gid}" -- "${token_file}"
chmod 0640 -- "${token_file}"

environment_tmp="$(mktemp --tmpdir="${script_dir}" .env.new.XXXXXX)"
cleanup() {
  if [[ -n "${environment_tmp:-}" ]]; then
    rm -f -- "${environment_tmp}"
  fi
}
trap cleanup EXIT
awk \
  -v data_root="${data_root}" \
  -v token_file="${token_file}" \
  -v host_port="${host_port}" \
  -v service_uid="${service_uid}" \
  -v service_gid="${service_gid}" \
  -v expected_mount="${expected_mount}" \
  -v expected_source="${expected_source}" \
  -v expected_fqdn="${expected_fqdn}" \
  -v bundle_manifest_sha256="${bundle_manifest_sha256}" \
  -v runtime_release_sha256="${runtime_release_sha256}" '
    /^MARKITDOWN_DATA_ROOT=/ { print "MARKITDOWN_DATA_ROOT=" data_root; next }
    /^MARKITDOWN_TOKEN_FILE=/ { print "MARKITDOWN_TOKEN_FILE=" token_file; next }
    /^MARKITDOWN_HOST_PORT=/ { print "MARKITDOWN_HOST_PORT=" host_port; next }
    /^MARKITDOWN_UID=/ { print "MARKITDOWN_UID=" service_uid; next }
    /^MARKITDOWN_GID=/ { print "MARKITDOWN_GID=" service_gid; next }
    /^MARKITDOWN_EXPECTED_MOUNT=/ { print "MARKITDOWN_EXPECTED_MOUNT=" expected_mount; next }
    /^MARKITDOWN_EXPECTED_SOURCE=/ { print "MARKITDOWN_EXPECTED_SOURCE=" expected_source; next }
    /^MARKITDOWN_TAILNET_FQDN=/ { print "MARKITDOWN_TAILNET_FQDN=" expected_fqdn; next }
    /^MARKITDOWN_BUNDLE_MANIFEST_SHA256=/ {
      print "MARKITDOWN_BUNDLE_MANIFEST_SHA256=" bundle_manifest_sha256
      next
    }
    /^MARKITDOWN_RELEASE_MANIFEST_SHA256=/ {
      print "MARKITDOWN_RELEASE_MANIFEST_SHA256=" runtime_release_sha256
      next
    }
    { print }
  ' "${script_dir}/.env.example" >"${environment_tmp}"
chmod 0600 -- "${environment_tmp}"

if [[ -f "${environment_file}" ]]; then
  if [[ "${replace_config}" == true ]]; then
    if ! cmp -s -- "${environment_tmp}" "${environment_file}"; then
      backup_file="$(mktemp --tmpdir="${script_dir}" .env.backup-XXXXXXXXXX)"
      install -m 0600 -- "${environment_file}" "${backup_file}"
      mv -fT -- "${environment_tmp}" "${environment_file}"
      environment_tmp=""
      echo "Previous .env preserved at ${backup_file}"
    fi
  fi
else
  mv -fT -- "${environment_tmp}" "${environment_file}"
  environment_tmp=""
fi

# verify-release intentionally rejects in-progress .env.new.* files. Consume or
# remove the same-directory temporary before the final runtime preflight so the
# release tree is closed while preserving atomic replacement of .env.
cleanup
trap - EXIT

echo "Runtime directories and configuration are ready."
echo "The token source was not deleted; remove the staging copy after the client token is verified."
bash "${script_dir}/preflight.sh" \
  --data-root "${data_root}" \
  --token-file "${token_file}" \
  --host-port "${host_port}" \
  --service-uid "${service_uid}" \
  --service-gid "${service_gid}" \
  --expected-mount "${expected_mount}" \
  --expected-source "${expected_source}" \
  --expected-tailnet-fqdn "${expected_fqdn}" \
  --expected-bundle-manifest-sha256 "${bundle_manifest_sha256}" \
  --runtime-release-manifest-sha256 "${runtime_release_sha256}" \
  --require-runtime
