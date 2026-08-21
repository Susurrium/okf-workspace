#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose is required" >&2; exit 1; }
test -f .env || { echo "copy .env.example to .env and set the HTTPS domain" >&2; exit 1; }
test -f secrets/couchdb.env || { echo "create secrets/couchdb.env from its example" >&2; exit 1; }

docker compose config --quiet
docker compose pull
docker compose up -d
docker compose ps
