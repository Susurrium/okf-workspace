#!/usr/bin/env bash
set -euo pipefail
umask 0077

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "$APP_DIR/env.sh"
# shellcheck source=lib.sh
source "$APP_DIR/lib.sh"

mineru_ensure_runtime_dirs
exec 7>"$MINERU_RUN_DIR/client.lock"
if ! flock -n 7; then
  echo "lease=busy" >&2
  exit 75
fi

echo "lease=acquired"
# The SSH client keeps this channel open.  Disconnecting or terminating that
# exact client closes stdin, exits cat, and releases fd 7 even after a crash.
cat >/dev/null
