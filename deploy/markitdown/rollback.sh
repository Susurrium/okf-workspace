#!/usr/bin/env bash
set -euo pipefail
umask 077

((EUID == 0)) || {
  echo "Run rollback.sh through sudo." >&2
  exit 1
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "${script_dir}/../.." && pwd -P)"
cd "${script_dir}"

while IFS= read -r variable_name; do
  if [[ "${variable_name}" == MARKITDOWN_* ]]; then
    echo "Do not override recorded rollback settings through the process environment: ${variable_name}" >&2
    exit 1
  fi
done < <(compgen -e)

fail() {
  echo "ROLLBACK FAILED: $*" >&2
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

if (($#)); then
  echo "Usage: sudo bash rollback.sh" >&2
  echo "Explicit image-only rollback is unsafe; use the recorded complete release snapshot." >&2
  exit 2
fi

[[ -f .env && ! -L .env ]] || fail "missing safe .env"
for release_file in .last-known-good-release .last-known-good.env; do
  [[ -f "${release_file}" && ! -L "${release_file}" ]] || \
    fail "${release_file} is missing or unsafe"
done

IFS=$'\t' read -r \
  rollback_image rollback_image_id rollback_build_id rollback_release_sha256 \
  rollback_bundle_sha256 rollback_compose_sha256 rollback_environment_sha256 extra \
  <.last-known-good-release
[[ -z "${extra:-}" ]] || fail "recorded rollback release has unexpected fields"
[[ "${rollback_image}" =~ ^[A-Za-z0-9._/:@-]+$ ]] || fail "unsafe rollback image reference"
[[ "${rollback_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "unsafe rollback image ID"
[[ "${rollback_build_id}" =~ ^[A-Za-z0-9._:+-]+$ ]] || fail "unsafe rollback build identity"
for digest in \
  "${rollback_release_sha256}" "${rollback_bundle_sha256}" \
  "${rollback_compose_sha256}" "${rollback_environment_sha256}"; do
  [[ "${digest}" =~ ^[0-9a-f]{64}$ ]] || fail "recorded rollback release has an unsafe digest"
done

actual_environment_sha256="$(sha256sum .last-known-good.env | awk '{print $1}')"
[[ "${actual_environment_sha256}" == "${rollback_environment_sha256}" ]] || \
  fail "rollback environment snapshot digest mismatch"
[[ "$(env_value_from_file .last-known-good.env MARKITDOWN_ENGINE_BUILD_ID)" == "${rollback_build_id}" \
  && "$(env_value_from_file .last-known-good.env MARKITDOWN_RELEASE_MANIFEST_SHA256)" == "${rollback_release_sha256}" \
  && "$(env_value_from_file .last-known-good.env MARKITDOWN_BUNDLE_MANIFEST_SHA256)" == "${rollback_bundle_sha256}" ]] || \
  fail "rollback environment snapshot does not match the recorded release identity"

actual_image_id="$(docker image inspect --format '{{.Id}}' "${rollback_image}")"
[[ "${actual_image_id}" == "${rollback_image_id}" ]] || \
  fail "rollback image tag no longer resolves to its recorded immutable image ID"

old_bundle_rendered_sha256="$(
  docker compose --env-file .last-known-good.env config | sha256sum | awk '{print $1}'
)"
[[ "${old_bundle_rendered_sha256}" == "${rollback_compose_sha256}" ]] || {
  echo "ROLLBACK FAILED: the current bundle cannot reproduce the recorded Compose configuration." >&2
  echo "Restore the release bundle whose manifest digest is ${rollback_bundle_sha256}, then retry." >&2
  exit 1
}

bash ./verify-release.sh "${repository_root}"
current_bundle_sha256="$(sha256sum "${repository_root}/release-manifest.sha256" | awk '{print $1}')"
[[ "${current_bundle_sha256}" =~ ^[0-9a-f]{64}$ ]] || fail "current bundle digest is invalid"

environment_tmp="$(mktemp --tmpdir="${script_dir}" .env.rollback.XXXXXX)"
awk \
  -v image="${rollback_image}" \
  -v bundle_sha256="${current_bundle_sha256}" '
  /^MARKITDOWN_IMAGE=/ {
    print "MARKITDOWN_IMAGE=" image
    image_seen += 1
    next
  }
  /^MARKITDOWN_BUNDLE_MANIFEST_SHA256=/ {
    print "MARKITDOWN_BUNDLE_MANIFEST_SHA256=" bundle_sha256
    bundle_seen += 1
    next
  }
  { print }
  END { if (image_seen != 1 || bundle_seen != 1) exit 1 }
' .last-known-good.env >"${environment_tmp}" || fail "cannot prepare the rollback environment"
chmod 0600 "${environment_tmp}"

data_root="$(env_value_from_file "${environment_tmp}" MARKITDOWN_DATA_ROOT)"
token_file="$(env_value_from_file "${environment_tmp}" MARKITDOWN_TOKEN_FILE)"
host_port="$(env_value_from_file "${environment_tmp}" MARKITDOWN_HOST_PORT)"
service_uid="$(env_value_from_file "${environment_tmp}" MARKITDOWN_UID)"
service_gid="$(env_value_from_file "${environment_tmp}" MARKITDOWN_GID)"
expected_mount="$(env_value_from_file "${environment_tmp}" MARKITDOWN_EXPECTED_MOUNT)"
expected_source="$(env_value_from_file "${environment_tmp}" MARKITDOWN_EXPECTED_SOURCE)"
expected_fqdn="$(env_value_from_file "${environment_tmp}" MARKITDOWN_TAILNET_FQDN)"

backup_file="$(mktemp --tmpdir="${script_dir}" .env.before-rollback-XXXXXXXXXX)"
install -m 0600 -- .env "${backup_file}"
rollback_committed=false
canary_directory=""
canary_pdf=""
restore_environment() {
  if [[ "${rollback_committed}" != true && -f "${backup_file}" ]]; then
    install -m 0600 -- "${backup_file}" .env
    echo "Rollback did not commit; restored the pre-rollback .env." >&2
  fi
  if [[ -n "${canary_pdf}" ]]; then
    rm -f -- "${canary_pdf}"
  fi
  if [[ -n "${canary_directory}" ]]; then
    rmdir -- "${canary_directory}" 2>/dev/null || true
  fi
  rm -f -- "${environment_tmp}"
}
trap restore_environment EXIT
install -m 0600 -- "${environment_tmp}" .env

bash ./preflight.sh \
  --data-root "${data_root}" \
  --token-file "${token_file}" \
  --host-port "${host_port}" \
  --service-uid "${service_uid}" \
  --service-gid "${service_gid}" \
  --expected-mount "${expected_mount}" \
  --expected-source "${expected_source}" \
  --expected-tailnet-fqdn "${expected_fqdn}" \
  --expected-bundle-manifest-sha256 "${current_bundle_sha256}" \
  --runtime-release-manifest-sha256 "${rollback_release_sha256}" \
  --require-runtime

canary_directory="$(mktemp -d --tmpdir="${script_dir}" .rollback-canary.XXXXXX)"
canary_pdf="${canary_directory}/canary.pdf"
python3 ./generate-canary.py "${canary_pdf}" >/dev/null

if ! docker compose up -d --no-build --remove-orphans --wait --wait-timeout 180; then
  systemctl stop obsidian-markitdown-proxy.service \
    obsidian-markitdown-proxy.socket >/dev/null 2>&1 || true
  docker compose stop >/dev/null 2>&1 || true
  fail "rollback containers did not become healthy and were stopped"
fi
if ! bash ./configure-loopback-proxy.sh; then
  systemctl stop obsidian-markitdown-proxy.service \
    obsidian-markitdown-proxy.socket >/dev/null 2>&1 || true
  docker compose stop >/dev/null 2>&1 || true
  fail "loopback proxy configuration failed; rollback was stopped"
fi
if ! python3 ./verify.py \
  --base-url "http://127.0.0.1:${host_port}" \
  --token-file "${token_file}" \
  --expected-build-id "${rollback_build_id}" \
  --expected-release-manifest-sha256 "${rollback_release_sha256}" \
  --health-timeout 180 \
  --pdf "${canary_pdf}" \
  --expected-markdown-text "Obsidian MarkItDown deployment canary"; then
  systemctl stop obsidian-markitdown-proxy.service \
    obsidian-markitdown-proxy.socket >/dev/null 2>&1 || true
  docker compose stop >/dev/null 2>&1 || true
  fail "rollback release did not pass verification and was stopped"
fi
docker compose ps

rolled_back_container="$(docker compose ps -q api)"
rolled_back_image_id="$(docker inspect --format '{{.Image}}' "${rolled_back_container}")"
[[ "${rolled_back_image_id}" == "${rollback_image_id}" ]] || \
  fail "running rollback container does not use the recorded image ID"
compose_sha256="$(docker compose config | sha256sum | awk '{print $1}')"
current_environment_tmp="$(mktemp --tmpdir="${script_dir}" .current-release.env.XXXXXX)"
install -m 0600 -- .env "${current_environment_tmp}"
current_release_tmp="$(mktemp --tmpdir="${script_dir}" .current-release.XXXXXX)"
printf '%s\t%s\t%s\t%s\t%s\n' \
  "${rolled_back_image_id}" "${rollback_build_id}" "${rollback_release_sha256}" \
  "${current_bundle_sha256}" "${compose_sha256}" >"${current_release_tmp}"
chmod 0600 "${current_release_tmp}"
mv -f -- "${current_environment_tmp}" .current-release.env
mv -f -- "${current_release_tmp}" .current-release
rollback_committed=true
rm -f -- "${canary_pdf}"
rmdir -- "${canary_directory}"
trap - EXIT
rm -f -- "${environment_tmp}"

echo "Rollback image is running: ${rollback_image}"
echo "Rollback build identity is: ${rollback_build_id}"
echo "Rollback runtime release identity is: ${rollback_release_sha256}"
echo "Current bundle identity is: ${current_bundle_sha256}"
echo "Pre-rollback configuration is preserved at ${backup_file}."
