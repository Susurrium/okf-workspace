#!/usr/bin/env bash
set -euo pipefail

((EUID == 0)) || {
  echo "Run start.sh through sudo or systemd." >&2
  exit 1
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "${script_dir}"

while IFS= read -r variable_name; do
  if [[ "${variable_name}" == MARKITDOWN_* ]]; then
    echo "Do not override recorded release settings through the process environment: ${variable_name}" >&2
    exit 1
  fi
done < <(compgen -e)

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

env_value() {
  env_value_from_file .env "$1"
}

[[ -f .env && ! -L .env ]] || {
  echo "Missing safe .env; run prepare-runtime.sh first." >&2
  exit 1
}
for release_file in .current-release .current-release.env; do
  [[ -f "${release_file}" && ! -L "${release_file}" ]] || {
    echo "Missing safe ${release_file}; complete a verified deployment first." >&2
    exit 1
  }
done

image_reference="$(env_value MARKITDOWN_IMAGE)"
data_root="$(env_value MARKITDOWN_DATA_ROOT)"
token_file="$(env_value MARKITDOWN_TOKEN_FILE)"
host_port="$(env_value MARKITDOWN_HOST_PORT)"
service_uid="$(env_value MARKITDOWN_UID)"
service_gid="$(env_value MARKITDOWN_GID)"
build_id="$(env_value MARKITDOWN_ENGINE_BUILD_ID)"
expected_mount="$(env_value MARKITDOWN_EXPECTED_MOUNT)"
expected_source="$(env_value MARKITDOWN_EXPECTED_SOURCE)"
expected_fqdn="$(env_value MARKITDOWN_TAILNET_FQDN)"
bundle_manifest_sha256="$(env_value MARKITDOWN_BUNDLE_MANIFEST_SHA256)"
release_manifest_sha256="$(env_value MARKITDOWN_RELEASE_MANIFEST_SHA256)"

IFS=$'\t' read -r \
  recorded_image_id recorded_build_id recorded_release_sha256 recorded_bundle_sha256 \
  recorded_compose_sha256 recorded_extra <.current-release
[[ -z "${recorded_extra:-}" ]] || {
  echo "Recorded current release has unexpected fields." >&2
  exit 1
}
[[ "${recorded_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo "Recorded current image ID is unsafe." >&2
  exit 1
}
[[ "${recorded_build_id}" =~ ^[A-Za-z0-9._:+-]+$ ]] || {
  echo "Recorded current build ID is unsafe." >&2
  exit 1
}
for digest in \
  "${recorded_release_sha256}" "${recorded_bundle_sha256}" "${recorded_compose_sha256}"; do
  [[ "${digest}" =~ ^[0-9a-f]{64}$ ]] || {
    echo "Recorded current release contains an unsafe digest." >&2
    exit 1
  }
done
[[ "${build_id}" == "${recorded_build_id}" \
  && "${release_manifest_sha256}" == "${recorded_release_sha256}" \
  && "${bundle_manifest_sha256}" == "${recorded_bundle_sha256}" ]] || {
  echo ".env does not match the recorded current release identity." >&2
  exit 1
}
cmp -s -- .env .current-release.env || {
  echo ".env differs from the verified current release snapshot." >&2
  exit 1
}

bash ./preflight.sh \
  --data-root "${data_root}" \
  --token-file "${token_file}" \
  --host-port "${host_port}" \
  --service-uid "${service_uid}" \
  --service-gid "${service_gid}" \
  --expected-mount "${expected_mount}" \
  --expected-source "${expected_source}" \
  --expected-tailnet-fqdn "${expected_fqdn}" \
  --expected-bundle-manifest-sha256 "${bundle_manifest_sha256}" \
  --runtime-release-manifest-sha256 "${release_manifest_sha256}" \
  --require-runtime

local_image_id="$(docker image inspect --format '{{.Id}}' "${image_reference}")"
[[ "${local_image_id}" == "${recorded_image_id}" ]] || {
  echo "Configured image reference no longer resolves to the recorded image ID." >&2
  exit 1
}
compose_sha256="$(docker compose config | sha256sum | awk '{print $1}')"
[[ "${compose_sha256}" == "${recorded_compose_sha256}" ]] || {
  echo "Rendered Compose configuration differs from the recorded current release." >&2
  exit 1
}

stop_failed_start() {
  systemctl stop obsidian-markitdown-proxy.service \
    obsidian-markitdown-proxy.socket >/dev/null 2>&1 || true
  docker compose stop >/dev/null 2>&1 || true
}

if ! docker compose up -d --no-build --remove-orphans --wait --wait-timeout 180; then
  stop_failed_start
  echo "MarkItDown failed closed because Compose could not start the recorded release." >&2
  exit 1
fi
if ! bash ./configure-loopback-proxy.sh; then
  stop_failed_start
  echo "MarkItDown failed closed because the loopback proxy could not be configured." >&2
  exit 1
fi
if ! python3 ./verify.py \
  --base-url "http://127.0.0.1:${host_port}" \
  --token-file "${token_file}" \
  --expected-build-id "${build_id}" \
  --expected-release-manifest-sha256 "${release_manifest_sha256}" \
  --health-timeout 180; then
  stop_failed_start
  echo "MarkItDown failed closed because the recorded release did not pass verification." >&2
  exit 1
fi
running_container="$(docker compose ps -q api)"
running_image_id="$(docker inspect --format '{{.Image}}' "${running_container}")"
[[ "${running_image_id}" == "${recorded_image_id}" ]] || {
  echo "Running API container does not use the recorded image ID." >&2
  exit 1
}
