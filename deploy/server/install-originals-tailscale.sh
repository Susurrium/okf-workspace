#!/usr/bin/env sh
# Independent stack for an existing Tailscale Serve / CouchDB installation.
set -eu
cd "$(dirname "$0")"
test -f .env || { echo 'Configure .env first' >&2; exit 1; }
command -v docker >/dev/null
command -v tailscale >/dev/null
mkdir -p secrets
if ! test -f secrets/original-files.token; then
    umask 077
    python3 -c 'import secrets; print(secrets.token_urlsafe(48))' > secrets/original-files.token
fi
chown 10001:10001 secrets/original-files.token
chmod 400 secrets/original-files.token
data_dir=$(sed -n 's/^OKF_FILES_DATA_DIR=//p' .env | tail -n 1)
case "$data_dir" in /*) ;; *) echo 'Data directory must be absolute' >&2; exit 1 ;; esac
test "$(realpath -m "$data_dir")" != / || exit 1
mkdir -p "$data_dir"
chown 10001:10001 "$data_dir"
chmod 700 "$data_dir"
docker compose -f compose.originals-tailscale.yml config --quiet
docker compose -f compose.originals-tailscale.yml up -d --build --wait originals
# Persist the previous routes for inspection and rollback; never reset Serve.
umask 077
tailscale serve status --json > "secrets/serve-before-$(date -u +%Y%m%dT%H%M%SZ).json"
tailscale serve --bg --yes --https=443 --set-path=/original-files http://127.0.0.1:8787
tailscale serve status
