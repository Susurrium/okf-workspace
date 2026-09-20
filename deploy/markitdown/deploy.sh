#!/usr/bin/env bash
set -euo pipefail
umask 077

((EUID == 0)) || {
  echo "Run deploy.sh through sudo so the protected server token remains unreadable to ordinary users." >&2
  exit 1
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "${script_dir}"

while IFS= read -r variable_name; do
  if [[ "${variable_name}" == MARKITDOWN_* ]]; then
    echo "Do not override release settings through the process environment: ${variable_name}" >&2
    echo "Record reviewed deployment values in .env so they can be snapshotted and rolled back." >&2
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

[[ "${build_id}" =~ ^[A-Za-z0-9._:+-]+$ ]] || {
  echo "Unsafe build identity in .env." >&2
  exit 1
}
[[ "${bundle_manifest_sha256}" =~ ^[0-9a-f]{64}$ ]] || {
  echo "Unsafe bundle manifest identity in .env." >&2
  exit 1
}
[[ "${release_manifest_sha256}" == "${bundle_manifest_sha256}" ]] || {
  echo "A new deployment must build the image from the current verified bundle." >&2
  echo "Set MARKITDOWN_RELEASE_MANIFEST_SHA256 equal to MARKITDOWN_BUNDLE_MANIFEST_SHA256." >&2
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

existing_container="$(docker compose ps --all -q api)"
if [[ -n "${existing_container}" ]]; then
  existing_status="$(docker inspect --format '{{.State.Status}}' "${existing_container}")"
  existing_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${existing_container}")"
  if [[ "${existing_status}" == "running" && "${existing_health}" == "healthy" ]]; then
    for release_file in .current-release .current-release.env; do
      [[ -f "${release_file}" && ! -L "${release_file}" ]] || {
        echo "A healthy service exists but ${release_file} is missing or unsafe." >&2
        echo "Refusing an upgrade without a complete rollback snapshot." >&2
        exit 1
      }
    done
    existing_image="$(docker inspect --format '{{.Image}}' "${existing_container}")"
    existing_identity="$(
      docker inspect "${existing_container}" | python3 -c '
import json
import sys
container = json.load(sys.stdin)[0]
environment = container["Config"].get("Env") or []
def one(name):
    values = [item.split("=", 1)[1] for item in environment if item.startswith(name + "=")]
    if len(values) != 1 or not values[0]:
        raise SystemExit(1)
    return values[0]
print(one("MARKITDOWN_ENGINE_BUILD_ID") + "\t" + one("MARKITDOWN_RELEASE_MANIFEST_SHA256"))
'
    )" || {
      echo "Cannot determine the running release identity; refusing to mark it for rollback." >&2
      exit 1
    }
    IFS=$'\t' read -r existing_build_id existing_release_sha256 extra <<<"${existing_identity}"
    [[ -z "${extra:-}" ]] || {
      echo "Running release identity has unexpected fields." >&2
      exit 1
    }
    [[ "${existing_build_id}" =~ ^[A-Za-z0-9._:+-]+$ ]] || {
      echo "Running build identity has an unsafe format." >&2
      exit 1
    }
    [[ "${existing_release_sha256}" =~ ^[0-9a-f]{64}$ ]] || {
      echo "Running release manifest identity has an unsafe format." >&2
      exit 1
    }

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
    [[ "${recorded_image_id}" == "${existing_image}" \
      && "${recorded_build_id}" == "${existing_build_id}" \
      && "${recorded_release_sha256}" == "${existing_release_sha256}" ]] || {
      echo "The healthy container does not match .current-release; refusing to bless it for rollback." >&2
      exit 1
    }
    [[ "$(env_value_from_file .current-release.env MARKITDOWN_ENGINE_BUILD_ID)" == "${recorded_build_id}" \
      && "$(env_value_from_file .current-release.env MARKITDOWN_RELEASE_MANIFEST_SHA256)" == "${recorded_release_sha256}" \
      && "$(env_value_from_file .current-release.env MARKITDOWN_BUNDLE_MANIFEST_SHA256)" == "${recorded_bundle_sha256}" ]] || {
      echo "The current release environment snapshot does not match its recorded identity." >&2
      exit 1
    }

    rollback_image="obsidian-markitdown-service:rollback-$(date -u +%Y%m%dT%H%M%SZ)"
    docker image tag "${existing_image}" "${rollback_image}"
    rollback_environment_tmp="$(mktemp --tmpdir="${script_dir}" .last-known-good.env.XXXXXX)"
    install -m 0600 -- .current-release.env "${rollback_environment_tmp}"
    rollback_environment_sha256="$(sha256sum "${rollback_environment_tmp}" | awk '{print $1}')"
    rollback_tmp="$(mktemp --tmpdir="${script_dir}" .last-known-good-release.XXXXXX)"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "${rollback_image}" "${recorded_image_id}" "${recorded_build_id}" \
      "${recorded_release_sha256}" "${recorded_bundle_sha256}" \
      "${recorded_compose_sha256}" "${rollback_environment_sha256}" >"${rollback_tmp}"
    chmod 0600 "${rollback_tmp}"
    mv -f -- "${rollback_environment_tmp}" .last-known-good.env
    mv -f -- "${rollback_tmp}" .last-known-good-release
    echo "Preserved the healthy image, full environment, and release identity as ${rollback_image}."
  else
    echo "Existing API is not running and healthy; it will not be marked as a rollback image." >&2
  fi
fi

stop_unverified_release() {
  systemctl stop obsidian-markitdown-proxy.service \
    obsidian-markitdown-proxy.socket >/dev/null 2>&1 || true
  docker compose stop >/dev/null 2>&1 || true
}

python_image="$(env_value MARKITDOWN_PYTHON_IMAGE)"
if docker image inspect "${python_image}" >/dev/null 2>&1; then
  # Reuse the host's existing pinned base image if its registry is unreachable.
  # The locked Python dependencies still install from this release's context.
  echo "Using cached Python base image for the verified release build."
  docker compose build
else
  docker compose build --pull
fi
if ! docker compose up -d --remove-orphans --wait --wait-timeout 180; then
  docker compose ps >&2 || true
  docker compose logs --tail 120 api worker >&2 || true
  stop_unverified_release
  echo "Deployment failed closed because the containers did not become healthy." >&2
  exit 1
fi

if ! bash ./configure-loopback-proxy.sh; then
  docker compose ps >&2 || true
  docker compose logs --tail 120 api worker >&2 || true
  stop_unverified_release
  echo "Deployment failed closed because the loopback proxy could not be configured." >&2
  exit 1
fi

canary_directory="$(mktemp -d --tmpdir="${script_dir}" .deployment-canary.XXXXXX)"
canary_pdf="${canary_directory}/canary.pdf"
cleanup_canary() {
  rm -f -- "${canary_pdf}"
  rmdir -- "${canary_directory}" 2>/dev/null || true
}
trap cleanup_canary EXIT
python3 ./generate-canary.py "${canary_pdf}" >/dev/null

if ! python3 ./verify.py \
  --base-url "http://127.0.0.1:${host_port}" \
  --token-file "${token_file}" \
  --expected-build-id "${build_id}" \
  --expected-release-manifest-sha256 "${release_manifest_sha256}" \
  --health-timeout 180 \
  --pdf "${canary_pdf}" \
  --expected-markdown-text "Obsidian MarkItDown deployment canary"; then
  docker compose ps >&2 || true
  docker compose logs --tail 120 api worker >&2 || true
  stop_unverified_release
  echo "The unverified MarkItDown containers and loopback proxy were stopped." >&2
  if [[ -f .last-known-good-release ]]; then
    repository_root="$(cd -- "${script_dir}/../.." && pwd -P)"
    release_store="$(dirname -- "$(dirname -- "${repository_root}")")"
    if [[ -L "${release_store}/current" && -L "${release_store}/previous" \
      && "$(realpath -e -- "${release_store}/current")" == "${repository_root}" ]]; then
      echo "Deployment failed. Restore the retained bundle and image through:" >&2
      echo "  bash ${script_dir}/rollback-release-bundle.sh --release-store ${release_store}" >&2
    else
      echo "Deployment failed. A prior same-bundle image is available through: bash rollback.sh" >&2
    fi
  fi
  exit 1
fi
cleanup_canary
trap - EXIT

docker compose ps
deployed_container="$(docker compose ps -q api)"
deployed_image_id="$(docker inspect --format '{{.Image}}' "${deployed_container}")"
compose_sha256="$(docker compose config | sha256sum | awk '{print $1}')"
current_environment_tmp="$(mktemp --tmpdir="${script_dir}" .current-release.env.XXXXXX)"
install -m 0600 -- .env "${current_environment_tmp}"
current_release_tmp="$(mktemp --tmpdir="${script_dir}" .current-release.XXXXXX)"
printf '%s\t%s\t%s\t%s\t%s\n' \
  "${deployed_image_id}" "${build_id}" "${release_manifest_sha256}" \
  "${bundle_manifest_sha256}" "${compose_sha256}" \
  >"${current_release_tmp}"
chmod 0600 "${current_release_tmp}"
mv -f -- "${current_environment_tmp}" .current-release.env
mv -f -- "${current_release_tmp}" .current-release
if command -v systemctl >/dev/null 2>&1; then
  bash ./install-systemd.sh --replace
fi
echo "Deployment is healthy on the loopback endpoint http://127.0.0.1:${host_port}."
echo "Exact image, build, runtime release, bundle, and Compose identities are in .current-release."
echo "Tailscale Serve is intentionally configured as a separate, explicit step."
