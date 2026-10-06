# Original file service

Legacy recovery resource. Workspace 0.9.0 stores originals in the Vault and
synchronizes them through LiveSync; normal installations do not deploy this
service. See [current storage and migration](../../docs/DEPLOYMENT.md#original-migration).

This directory remains available until historical blobs are verified as migrated
and their rollback backups can be retired. Recovery code has its own
`scripts/check-legacy-originals.ps1` entry point and path-scoped/manual CI; it is
not part of the default Workspace check. The obsolete default-Compose installer
has been removed; the retained Tailscale deployment assets are recovery-only.

Authenticated immutable file storage for one Workspace. It has no Vault access,
conversion queue, Source records, or semantic decisions. The server stores raw
bytes by SHA-256; metadata and import requests remain Markdown in the Vault.

`PUT /v1/blobs/{sha256}` verifies streamed bytes (1 byte–64 MiB), flushes them to
disk and atomically publishes them. GET and HEAD require the same bearer token.
`GET /v1/status` returns the stable store identity. No remote delete endpoint is
provided: clearing a device cache cannot remove the archive. Requests with wrong
hashes, incomplete uploads, invalid identities, or unauthorized access fail closed.

Configuration: `OKF_FILES_ROOT`, `OKF_FILES_TOKEN_FILE`, `OKF_FILES_STORE_ID`.
Run behind HTTPS; the bundled deployment exposes only the existing Caddy proxy.
The container runs as UID 10001. Mount credentials and data with that owner.

See [setup and lifecycle](../../docs/DEPLOYMENT.md#original-migration).

Validation: `uv sync --extra dev --locked`, `uv run pytest`,
`uv run ruff check src tests`, and `uv run pyright`.
