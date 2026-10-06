#!/usr/bin/env sh
# Run on the server, after configuring the existing compose stack's .env.
set -eu
cd "$(dirname "$0")"
test -f .env || { echo 'Configure .env first' >&2; exit 1; }
command -v docker >/dev/null 2>&1
mkdir -p secrets
if ! test -f secrets/original-files.token; then
    umask 077
    python3 -c 'import secrets; print(secrets.token_urlsafe(48))' > secrets/original-files.token
fi
# The unprivileged container user must be able to read its mounted credential.
chown 10001:10001 secrets/original-files.token
chmod 400 secrets/original-files.token
data_dir=$(sed -n 's/^OKF_FILES_DATA_DIR=//p' .env | tail -n 1)
data_dir=${data_dir:-/var/lib/okf-original-files}
case "$data_dir" in /*) ;; *) echo 'OKF_FILES_DATA_DIR must be absolute' >&2; exit 1 ;; esac
test "$data_dir" != / || { echo 'Refusing filesystem root as data directory' >&2; exit 1; }
mkdir -p "$data_dir"
chown 10001:10001 "$data_dir"
chmod 700 "$data_dir"
docker compose --profile originals config --quiet
docker compose --profile originals up -d --build originals
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
docker compose --profile originals ps
