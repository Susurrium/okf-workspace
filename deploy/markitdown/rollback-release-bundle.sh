#!/usr/bin/env bash
set -euo pipefail
umask 077

release_store="/opt/markitdown-releases"

usage() {
  echo "Usage: sudo bash rollback-release-bundle.sh [--release-store /opt/markitdown-releases]" >&2
}

fail() {
  echo "BUNDLE ROLLBACK FAILED: $*" >&2
  exit 1
}

atomic_copy() {
  local source="$1"
  local destination="$2"
  local temporary
  temporary="$(mktemp --tmpdir="$(dirname -- "${destination}")" .rollback-record.XXXXXX)"
  if ! install -o root -g root -m 0600 -- "${source}" "${temporary}"; then
    rm -f -- "${temporary}"
    return 1
  fi
  if ! mv -Tf -- "${temporary}" "${destination}"; then
    rm -f -- "${temporary}"
    return 1
  fi
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
    --release-store)
      (($# >= 2)) || { usage; exit 2; }
      release_store="$2"
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
[[ "${release_store}" == /* && "${release_store}" =~ ^/[A-Za-z0-9._/-]+$ ]] || \
  fail "release store must be a safe absolute path"
canonical_store="$(realpath -e -- "${release_store}")" || fail "release store is missing"
[[ "${canonical_store}" == "${release_store%/}" && ! -L "${release_store}" ]] || \
  fail "release store must be canonical and must not traverse symlinks"

exec 9>"${release_store}/.install.lock"
flock -n 9 || fail "another release operation is already running"
current_link="${release_store}/current"
previous_link="${release_store}/previous"
[[ -L "${current_link}" && -L "${previous_link}" ]] || \
  fail "both managed current and previous pointers are required"
current="$(realpath -e -- "${current_link}")" || fail "current release pointer is broken"
previous="$(realpath -e -- "${previous_link}")" || fail "previous release pointer is broken"
[[ "${current}" != "${previous}" ]] || fail "current and previous releases are identical"

for release in "${current}" "${previous}"; do
  [[ -d "${release}" && ! -L "${release}" ]] || fail "release is not a regular directory: ${release}"
  bash "${release}/deploy/markitdown/verify-release.sh" "${release}"
done

current_runtime="${current}/deploy/markitdown"
previous_runtime="${previous}/deploy/markitdown"
for record in .last-known-good-release .last-known-good.env; do
  [[ -f "${current_runtime}/${record}" && ! -L "${current_runtime}/${record}" ]] || \
    fail "current release has no safe ${record}; deploy.sh did not preserve a rollback point"
done

IFS=$'\t' read -r \
  _rollback_image _rollback_image_id _rollback_build_id _rollback_release_sha256 \
  rollback_bundle_sha256 _rollback_compose_sha256 _rollback_environment_sha256 extra \
  <"${current_runtime}/.last-known-good-release"
[[ -z "${extra:-}" ]] || fail "rollback record has unexpected fields"
[[ "${rollback_bundle_sha256}" =~ ^[0-9a-f]{64}$ ]] || \
  fail "rollback record has an unsafe bundle digest"
previous_bundle_sha256="$(sha256sum "${previous}/release-manifest.sha256" | awk '{print $1}')"
[[ "${previous_bundle_sha256}" == "${rollback_bundle_sha256}" ]] || {
  echo "BUNDLE ROLLBACK FAILED: retained previous bundle does not match the recorded healthy release." >&2
  echo "Expected ${rollback_bundle_sha256}; found ${previous_bundle_sha256}." >&2
  exit 1
}

install -d -o root -g root -m 0700 -- "${release_store}/rollback-records"
record_backup="$(
  mktemp -d \
    --tmpdir="${release_store}/rollback-records" \
    "$(date -u +%Y%m%dT%H%M%SZ)-${previous_bundle_sha256}-XXXXXX"
)"
for record in .last-known-good-release .last-known-good.env; do
  if [[ -f "${previous_runtime}/${record}" && ! -L "${previous_runtime}/${record}" ]]; then
    install -o root -g root -m 0600 -- \
      "${previous_runtime}/${record}" "${record_backup}/${record}.before-bundle-rollback"
  fi
  atomic_copy "${current_runtime}/${record}" "${previous_runtime}/${record}"
done

if ! bash "${previous_runtime}/rollback.sh"; then
  echo "The previous bundle did not pass rollback verification; the release pointers were not changed." >&2
  echo "Attempting to restore the current verified release." >&2
  bash "${current_runtime}/start.sh" || true
  exit 1
fi

bash "${previous_runtime}/install-systemd.sh" --replace
atomic_link "${previous}" "${current_link}"
atomic_link "${current}" "${previous_link}"

echo "Bundle rollback completed and verified."
echo "Current release: ${previous}"
echo "Replaced release retained at: ${current}"
echo "Pre-existing rollback records, when present, were saved in: ${record_backup}"
