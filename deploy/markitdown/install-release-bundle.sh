#!/usr/bin/env bash
set -euo pipefail
umask 077

archive=""
checksum=""
release_store="/opt/markitdown-releases"
legacy_release="/opt/markitdown-backup"

usage() {
  cat >&2 <<'EOF'
Usage: sudo bash install-release-bundle.sh \
  --archive ABSOLUTE_TAR_GZ --checksum ABSOLUTE_SHA256 \
  [--release-store /opt/markitdown-releases] \
  [--legacy-release /opt/markitdown-backup]

The command verifies and installs a versioned bundle, prepares an upgrade
environment from the current healthy release, and atomically advances the
release-store current/previous pointers. It does not deploy containers.
EOF
}

fail() {
  echo "RELEASE INSTALL FAILED: $*" >&2
  exit 1
}

safe_absolute_path() {
  local value="$1"
  local label="$2"
  local canonical
  [[ "${value}" == /* && "${value}" =~ ^/[A-Za-z0-9._/-]+$ ]] || \
    fail "${label} must be a safe absolute path"
  canonical="$(realpath -m -- "${value}")" || fail "cannot resolve ${label}"
  [[ "${canonical}" == "${value%/}" ]] || \
    fail "${label} must be canonical and must not traverse symlinks: ${value}"
  case "${canonical}" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var)
      fail "${label} is too broad: ${canonical}"
      ;;
  esac
}

atomic_link() {
  local target="$1"
  local link="$2"
  local temporary
  temporary="$(mktemp --tmpdir="$(dirname -- "${link}")" .release-link.XXXXXX)"
  rm -f -- "${temporary}"
  if ! ln -s -- "${target}" "${temporary}"; then
    rm -f -- "${temporary}"
    return 1
  fi
  if ! mv -Tf -- "${temporary}" "${link}"; then
    rm -f -- "${temporary}"
    return 1
  fi
}

while (($#)); do
  case "$1" in
    --archive)
      (($# >= 2)) || { usage; exit 2; }
      archive="$2"
      shift 2
      ;;
    --checksum)
      (($# >= 2)) || { usage; exit 2; }
      checksum="$2"
      shift 2
      ;;
    --release-store)
      (($# >= 2)) || { usage; exit 2; }
      release_store="$2"
      shift 2
      ;;
    --legacy-release)
      (($# >= 2)) || { usage; exit 2; }
      legacy_release="$2"
      shift 2
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
[[ -n "${archive}" && -n "${checksum}" ]] || { usage; exit 2; }
safe_absolute_path "${archive}" "archive"
safe_absolute_path "${checksum}" "checksum"
safe_absolute_path "${release_store}" "release store"
safe_absolute_path "${legacy_release}" "legacy release"
[[ -f "${archive}" && ! -L "${archive}" ]] || fail "archive is not a regular file"
[[ -f "${checksum}" && ! -L "${checksum}" ]] || fail "checksum is not a regular file"
[[ "$(realpath -e -- "${archive}")" == "${archive}" ]] || fail "archive traverses a symlink"
[[ "$(realpath -e -- "${checksum}")" == "${checksum}" ]] || fail "checksum traverses a symlink"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
archive_helper="${script_dir}/release_bundle.py"
[[ -f "${archive_helper}" && ! -L "${archive_helper}" ]] || \
  fail "release archive helper is missing or unsafe"

install -d -o root -g root -m 0755 -- "${release_store}" "${release_store}/releases"
[[ ! -L "${release_store}" && ! -L "${release_store}/releases" ]] || \
  fail "release store directories must not be symbolic links"
exec 9>"${release_store}/.install.lock"
flock -n 9 || fail "another release installation is already running"

releases_dir="${release_store}/releases"
stage="$(mktemp -d --tmpdir="${releases_dir}" .incoming.XXXXXX)"
environment_tmp=""
cleanup_install() {
  if [[ -n "${stage:-}" && "${stage}" == "${releases_dir}/.incoming."* && -d "${stage}" ]]; then
    rm -rf -- "${stage}"
  fi
  if [[ -n "${environment_tmp:-}" \
    && "${environment_tmp}" == "${release_store}/.env.upgrade."* \
    && -f "${environment_tmp}" ]]; then
    rm -f -- "${environment_tmp}"
  fi
}
trap cleanup_install EXIT

manifest_sha256="$(
  python3 "${archive_helper}" verify-extract \
    --archive "${archive}" \
    --checksum "${checksum}" \
    --destination "${stage}"
)" || fail "archive verification or extraction failed"
[[ "${manifest_sha256}" =~ ^[0-9a-f]{64}$ ]] || fail "archive helper returned an invalid digest"
bash "${stage}/deploy/markitdown/verify-release.sh" "${stage}"

target="${releases_dir}/${manifest_sha256}"
if [[ -e "${target}" ]]; then
  [[ -d "${target}" && ! -L "${target}" ]] || fail "release target is not a regular directory"
  bash "${target}/deploy/markitdown/verify-release.sh" "${target}"
  cleanup_install
  stage=""
else
  mv -T -- "${stage}" "${target}"
  stage=""
fi

current_link="${release_store}/current"
previous_link="${release_store}/previous"
predecessor=""
if [[ -e "${previous_link}" || -L "${previous_link}" ]]; then
  [[ -L "${previous_link}" ]] || fail "managed previous pointer must be a symbolic link"
fi
if [[ -e "${current_link}" || -L "${current_link}" ]]; then
  [[ -L "${current_link}" ]] || fail "managed current pointer must be a symbolic link"
  predecessor="$(realpath -e -- "${current_link}")" || fail "managed current pointer is broken"
elif [[ -e "${legacy_release}" ]]; then
  [[ -d "${legacy_release}" && ! -L "${legacy_release}" ]] || \
    fail "legacy release must be a regular directory"
  predecessor="$(realpath -e -- "${legacy_release}")" || fail "cannot resolve legacy release"
fi

if [[ -n "${predecessor}" ]]; then
  bash "${predecessor}/deploy/markitdown/verify-release.sh" "${predecessor}"
fi

if [[ "${predecessor}" == "${target}" ]]; then
  echo "Release ${manifest_sha256} is already current."
  exit 0
fi

for runtime_file in \
  .env .current-release .current-release.env .last-known-good-release .last-known-good.env; do
  if [[ -e "${target}/deploy/markitdown/${runtime_file}" ]]; then
    fail "inactive release target already contains runtime state: ${runtime_file}"
  fi
done

if [[ -n "${predecessor}" ]]; then
  predecessor_runtime="${predecessor}/deploy/markitdown"
  for runtime_file in .env .current-release .current-release.env; do
    [[ -f "${predecessor_runtime}/${runtime_file}" && ! -L "${predecessor_runtime}/${runtime_file}" ]] || \
      fail "current release lacks safe ${runtime_file}; refusing an unaudited upgrade"
  done

  environment_tmp="$(mktemp --tmpdir="${release_store}" .env.upgrade.XXXXXX)"
  python3 "${target}/deploy/markitdown/release_bundle.py" prepare-upgrade-env \
    --example "${target}/deploy/markitdown/.env.example" \
    --previous "${predecessor_runtime}/.env" \
    --output "${environment_tmp}" \
    --manifest-sha256 "${manifest_sha256}"
  chmod 0600 -- "${environment_tmp}"
  mv -T -- "${environment_tmp}" "${target}/deploy/markitdown/.env"
  environment_tmp=""
  install -o root -g root -m 0600 -- \
    "${predecessor_runtime}/.current-release" \
    "${target}/deploy/markitdown/.current-release"
  install -o root -g root -m 0600 -- \
    "${predecessor_runtime}/.current-release.env" \
    "${target}/deploy/markitdown/.current-release.env"
  atomic_link "${predecessor}" "${previous_link}"
fi

bash "${target}/deploy/markitdown/verify-release.sh" "${target}"
atomic_link "${target}" "${current_link}"

echo "Installed and activated bundle ${manifest_sha256}."
echo "Current release: ${target}"
if [[ -n "${predecessor}" ]]; then
  echo "Previous release retained at: ${predecessor}"
  echo "Next: sudo bash ${current_link}/deploy/markitdown/deploy.sh"
  echo "If deployment fails: sudo bash ${current_link}/deploy/markitdown/rollback-release-bundle.sh"
else
  echo "This is an initial install; run prepare-runtime.sh before deploy.sh."
fi
