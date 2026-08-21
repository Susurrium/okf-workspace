#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="${1:-$(cd -- "${script_dir}/../.." && pwd -P)}"
manifest="${repository_root}/release-manifest.sha256"

fail() {
  echo "RELEASE VERIFY FAILED: $*" >&2
  exit 1
}

[[ "${repository_root}" == /* && -d "${repository_root}" && ! -L "${repository_root}" ]] || \
  fail "repository root must be a regular absolute directory"
[[ -f "${manifest}" && ! -L "${manifest}" ]] || fail "release-manifest.sha256 is missing"

declare -A declared_paths=()
entry_count=0
while IFS= read -r line || [[ -n "${line}" ]]; do
  [[ "${line}" =~ ^[0-9a-f]{64}[[:space:]][[:space:]][A-Za-z0-9_./-]+$ ]] || \
    fail "manifest contains a malformed entry"
  relative_path="${line:66}"
  case "/${relative_path}/" in
    *"/../"*|*"/./"*|*"//"*) fail "manifest contains an unsafe relative path" ;;
  esac
  [[ "${relative_path}" != /* && "${relative_path}" != *\\* ]] || \
    fail "manifest path must be relative and use forward slashes"
  [[ -z "${declared_paths[${relative_path}]+present}" ]] || \
    fail "manifest contains a duplicate path: ${relative_path}"
  declared_paths["${relative_path}"]=1
  candidate="${repository_root}/${relative_path}"
  [[ -f "${candidate}" && ! -L "${candidate}" ]] || \
    fail "manifest member is missing, linked, or not a regular file: ${relative_path}"
  ((entry_count += 1))
done <"${manifest}"
((entry_count >= 15)) || fail "release manifest has too few entries"

unexpected_link="$(find "${repository_root}" -xdev -type l -print -quit)"
[[ -z "${unexpected_link}" ]] || fail "release snapshot contains a symbolic link: ${unexpected_link}"

while IFS= read -r -d '' candidate; do
  relative_path="${candidate#"${repository_root}/"}"
  [[ "${relative_path}" =~ ^[A-Za-z0-9_./-]+$ ]] || \
    fail "release snapshot contains a file with an unsafe name"
  if [[ -n "${declared_paths[${relative_path}]+present}" ]]; then
    continue
  fi
  case "${relative_path}" in
    release-manifest.sha256|\
    deploy/markitdown/.env|\
    deploy/markitdown/.env.backup-*|\
    deploy/markitdown/.env.before-rollback-*|\
    deploy/markitdown/.last-known-good-release|\
    deploy/markitdown/.last-known-good.env|\
    deploy/markitdown/.current-release|\
    deploy/markitdown/.current-release.env)
      ;;
    *)
      fail "release snapshot contains an unmanifested file: ${relative_path}"
      ;;
  esac
done < <(find "${repository_root}" -xdev -type f -print0)

(
  cd "${repository_root}"
  sha256sum --check --strict --warn release-manifest.sha256
)
echo "Release snapshot verified (${entry_count} files)."
