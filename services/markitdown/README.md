# MarkItDown conversion service

A separately deployed PDF/PPTX/DOCX converter. The client retains originals, downloaded
results, QC and published notes; server task rows and spool are disposable TTL caches.
Deployment, runtime isolation, credentials, upgrades and recovery are documented in the
[server manual](../../deploy/markitdown/README.md). Workspace configuration lives in the
[deployment guide](../../docs/DEPLOYMENT.md#conversion).

## Identity and capabilities

| Field | Source baseline |
| --- | --- |
| Service | `1.4.0` |
| Build | `markitdown-0.1.6-py31213-assets-v3` |
| Result schema | `markitdown-result/v3` |
| Profile | `fallback-assets-v2` |

Confirm actual server identity through authenticated health. Changes that can affect output
require a new build ID; clients bind conversion/cache identity to the profile, build and source hash.

DOCX/PPTX extract supported embedded bitmaps, rewrite Markdown references to content-addressed
`images/<sha256>.<ext>` files and deduplicate identical bytes. Manifests record OOXML relationship/reference
counts and actual output references. Dangerous SVG and unsupported images produce explicit warnings.
PDF is text-only, without OCR, images or page mappings, and reports `pdf_text_only_images_not_extracted`.
Complex formulas, tables and layout require original-document review. Strict image QC does not add parser capability.
Legacy PPT/DOC conversion is performed by the Windows client before upload; the service accepts only derived OOXML formats.

## HTTP API

| Route | Authentication and result |
| --- | --- |
| `GET /livez` | Public; process liveness only |
| `GET /v1/health` | Bearer; identity, fixed capabilities, queue and Worker heartbeat |
| `POST /v1/tasks` | Bearer; raw upload; 202 new task or 200 idempotent replay |
| `GET /v1/tasks/{id}` | Bearer; pending/processing/completed/failed/cancelled/expired |
| `GET /v1/tasks/{id}/status` | Bearer; status alias |
| `GET /v1/tasks/{id}/result` | Bearer; 202 pending, ZIP on success, 410 expired |
| `DELETE /v1/tasks/{id}` | Bearer; cancel pending/processing work or clear cached results |

Uploads use raw bytes, with these headers:

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <device-token>` |
| `Content-Type` | PDF `application/pdf`; PPTX `application/vnd.openxmlformats-officedocument.presentationml.presentation`; DOCX `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| `Idempotency-Key` | 16–200 safe ASCII characters, incorporating profile/build/source identity |
| `X-Source-SHA256` | 64 hexadecimal characters |
| `X-Filename` | Optional percent-encoded display name; never a disk path |
| `X-MarkItDown-Profile` | `fallback-assets-v2` |

Multipart, URLs, server paths and other formats are rejected. PDF magic, OOXML package structure,
path safety, duplicate/encrypted entries, required parts, VBA, expanded sizes and logical-unit counts
are checked; all uploads are hashed. An idempotency key bound to different input/profile returns 409.
Expired successful results can be recreated safely with the same key.

## Result bundle and client verification

The ZIP contains `manifest.json`, `document.md`, and optional bitmap files under `images/`.
PDF contains exactly the first two files. The manifest binds source and Markdown hashes/bytes,
engine/service/build, profile, source format, logical units (`page|slide|document`), asset path/hash/MIME/bytes,
OOXML reference counts and warnings. It does not invent PDF image lists or `content_list.json`.

Clients validate Content-Type, ZIP magic, compressed/expanded sizes, `X-Result-SHA256`, manifest identity,
Markdown and every asset hash. Legacy `markitdown-result/v2` remains readable; upgrades do not rewrite
published Source Text. Re-conversion is explicit and preserves human edits.

## Upload recovery and development

Uploads default to a 600-second total and 60-second idle limit. Interrupted uploads release temporary
files and slots. Durable upload ownership prevents TTL cleanup of active uploads; abandoned hidden
uploads/results are reclaimed after their configured orphan TTL. Every conversion runs in a bounded,
network-isolated child process; plugins are disabled.

From this directory run `uv sync`, `uv run pytest` and `uv run ruff check .`.
Queue polling, Worker heartbeats and expiry cleanup have independent schedules. Idle polling does not
rescan spool contents; capacity is checked before claiming pending work. Heartbeats run at most every
five seconds and within one third of the stale threshold; cleanup runs at most every sixty seconds
and within one quarter of the relevant cache TTL. Cancellation and conversion deadlines retain their
existing polling cadence, and active uploads remain protected during cleanup.
Supported deployment uses a host-loopback socket proxy to an internal-only API container,
authentication on every `/v1` route, and a Worker without networking.
