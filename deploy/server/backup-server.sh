#!/usr/bin/env sh
set -eu

: "${OKF_COUCHDB_URL:?set OKF_COUCHDB_URL}"
: "${OKF_COUCHDB_DATABASE:?set OKF_COUCHDB_DATABASE}"
: "${OKF_COUCHDB_CREDENTIALS:?set OKF_COUCHDB_CREDENTIALS}"
: "${OKF_COUCHDB_DUMP_DIR:?set OKF_COUCHDB_DUMP_DIR}"
: "${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY}"
: "${RESTIC_PASSWORD_FILE:?set RESTIC_PASSWORD_FILE}"

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
snapshot="$OKF_COUCHDB_DUMP_DIR/couchdb-$timestamp.json.gz"
mkdir -p "$OKF_COUCHDB_DUMP_DIR"
python3 "$script_dir/couchdb_snapshot.py" dump \
  --url "$OKF_COUCHDB_URL" \
  --database "$OKF_COUCHDB_DATABASE" \
  --credentials "$OKF_COUCHDB_CREDENTIALS" \
  --output "$snapshot"

if test -n "${OKF_FILES_DATA_DIR:-}"; then
    test -d "$OKF_FILES_DATA_DIR" || { echo 'Original file backup directory is missing' >&2; exit 1; }
    restic backup "$snapshot" "$script_dir" "$OKF_FILES_DATA_DIR"
else
    restic backup "$snapshot" "$script_dir"
fi
restic forget --keep-daily 7 --keep-weekly 8 --keep-monthly 12 --prune
find "$OKF_COUCHDB_DUMP_DIR" -type f -name 'couchdb-*.json.gz' -mtime +8 -delete
