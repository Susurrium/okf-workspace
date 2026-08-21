#!/usr/bin/env bash
set -euo pipefail
umask 077

((EUID == 0)) || {
  echo "Run reconcile-runtime-mount.sh through sudo." >&2
  exit 1
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "${script_dir}"

fail() {
  echo "MOUNT RECONCILIATION FAILED: $*" >&2
  exit 1
}

for command in awk cmp docker findmnt grep mktemp mv realpath sed sha256sum; do
  command -v "${command}" >/dev/null 2>&1 ||
    fail "required command is unavailable: ${command}"
done

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

for runtime_file in .env .current-release.env .current-release; do
  [[ -f "${runtime_file}" && ! -L "${runtime_file}" ]] ||
    fail "${runtime_file} is missing, linked, or not a regular file"
done

expected_mount="$(env_value_from_file .env MARKITDOWN_EXPECTED_MOUNT)" ||
  fail ".env has an invalid expected-mount field"
data_root="$(env_value_from_file .env MARKITDOWN_DATA_ROOT)" ||
  fail ".env has an invalid data-root field"
[[ "${expected_mount}" == /* && "${expected_mount}" =~ ^/[A-Za-z0-9._/-]+$ ]] ||
  fail "expected mount has an unsafe format"
[[ "$(realpath -m -- "${expected_mount}")" == "${expected_mount%/}" ]] ||
  fail "expected mount is not canonical"
[[ "${data_root}" == "${expected_mount}" || "${data_root}" == "${expected_mount}/"* ]] ||
  fail "data root is not on the expected mount"

mapfile -t fstab_sources < <(
  findmnt --fstab --target "${expected_mount}" -n -o SOURCE
)
((${#fstab_sources[@]} == 1)) ||
  fail "expected exactly one fstab entry for ${expected_mount}"
fstab_source="${fstab_sources[0]}"
[[ "${fstab_source}" =~ ^UUID=([0-9A-Fa-f-]{16,64})$ ]] ||
  fail "the fstab entry must identify the data filesystem by UUID"
expected_uuid="${BASH_REMATCH[1],,}"

findmnt --mountpoint "${expected_mount}" >/dev/null ||
  fail "${expected_mount} is not a mountpoint"
actual_uuid="$(findmnt -n -o UUID --target "${expected_mount}" | awk '{$1=$1; print}')" ||
  fail "cannot read the mounted filesystem UUID"
actual_uuid="${actual_uuid,,}"
[[ "${actual_uuid}" == "${expected_uuid}" ]] ||
  fail "mounted filesystem UUID ${actual_uuid} does not match fstab UUID ${expected_uuid}"
[[ "$(findmnt -n -o FSTYPE --target "${expected_mount}" | awk '{$1=$1; print}')" == "ext4" ]] ||
  fail "the data filesystem must be ext4"
mount_options="$(findmnt -n -o OPTIONS --target "${expected_mount}")"
for required_option in nodev nosuid noexec; do
  [[ ",${mount_options}," == *",${required_option},"* ]] ||
    fail "the data filesystem is missing mount option ${required_option}"
done
[[ -s "${data_root}/.obsidian-markitdown-data-v1" ]] ||
  fail "the MarkItDown data marker is missing"

actual_source="$(findmnt -n -o SOURCE --target "${expected_mount}" | awk '{$1=$1; print}')" ||
  fail "cannot determine the mounted block device"
[[ "${actual_source}" =~ ^/dev/[A-Za-z0-9._/+:-]+$ ]] ||
  fail "mounted source has an unsafe format: ${actual_source}"

for env_file in .env .current-release.env; do
  [[ "$(grep -c '^MARKITDOWN_EXPECTED_SOURCE=' "${env_file}")" == "1" ]] ||
    fail "${env_file} has an invalid expected-source field"
done

for env_file in .env .current-release.env; do
  replacement="$(mktemp --tmpdir="${script_dir}" ".${env_file#.}.XXXXXX")"
  sed \
    -E "s|^MARKITDOWN_EXPECTED_SOURCE=.*$|MARKITDOWN_EXPECTED_SOURCE=${actual_source}|" \
    "${env_file}" >"${replacement}"
  chown --reference="${env_file}" "${replacement}"
  chmod --reference="${env_file}" "${replacement}"
  mv -f -- "${replacement}" "${env_file}"
done
cmp -s .env .current-release.env ||
  fail "runtime environment and current-release snapshot differ"

IFS=$'\t' read -r \
  image_id build_id release_sha256 bundle_sha256 old_compose_sha256 extra \
  <.current-release
[[ -z "${extra:-}" ]] ||
  fail "current-release record has unexpected fields"
[[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  fail "current-release image identity is unsafe"
[[ "${build_id}" =~ ^[A-Za-z0-9._:+-]+$ ]] ||
  fail "current-release build identity is unsafe"
for digest in "${release_sha256}" "${bundle_sha256}" "${old_compose_sha256}"; do
  [[ "${digest}" =~ ^[0-9a-f]{64}$ ]] ||
    fail "current-release contains an unsafe digest"
done

compose_sha256="$(docker compose config | sha256sum | awk '{print $1}')"
[[ "${compose_sha256}" =~ ^[0-9a-f]{64}$ ]] ||
  fail "cannot calculate the reconciled Compose identity"
record_tmp="$(mktemp --tmpdir="${script_dir}" .current-release.XXXXXX)"
trap 'rm -f -- "${record_tmp:-}"' EXIT
printf '%s\t%s\t%s\t%s\t%s\n' \
  "${image_id}" "${build_id}" "${release_sha256}" "${bundle_sha256}" \
  "${compose_sha256}" >"${record_tmp}"
chown --reference=.current-release "${record_tmp}"
chmod --reference=.current-release "${record_tmp}"
mv -f -- "${record_tmp}" .current-release
trap - EXIT

echo "Runtime mount reconciled: UUID=${expected_uuid}, source=${actual_source}"
