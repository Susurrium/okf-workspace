#!/usr/bin/env bash
# Set ORIGINALS_DATA_DIR and ORIGINALS_BACKUP_MOUNT in the service environment.
set -euo pipefail
: "${ORIGINALS_DATA_DIR:?}"
: "${ORIGINALS_BACKUP_MOUNT:?}"
findmnt --mountpoint "${ORIGINALS_BACKUP_MOUNT}" >/dev/null
test -d "${ORIGINALS_DATA_DIR}"
test "$(realpath "${ORIGINALS_DATA_DIR}")" != /
umask 077
backup_dir="${ORIGINALS_BACKUP_MOUNT}/original-files"
mkdir -p "${backup_dir}"
exec 9>"${backup_dir}/.backup.lock"
flock -n 9
archive="${backup_dir}/original-files-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
trap 'rm -f -- "${archive}.partial"' EXIT
# Committed blobs are immutable; incomplete streamed uploads are excluded.
tar --create --gzip --exclude='.upload-*' --file "${archive}.partial" \
    --directory "${ORIGINALS_DATA_DIR}" .
gzip --test "${archive}.partial"
mv -- "${archive}.partial" "${archive}"
sha256sum "${archive}" > "${archive}.sha256"
sha256sum --check "${archive}.sha256"
# Retention is explicit; this script never deletes previous backups.
echo "${archive}"
