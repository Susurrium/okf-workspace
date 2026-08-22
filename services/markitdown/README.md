# Obsidian MarkItDown fallback service

This subproject is a deliberately narrow boundary around MarkItDown. It accepts only a raw PDF,
PPTX, or DOCX request body, never accepts a URI or server-side path, disables plugins, and runs each
conversion in a time-limited child process owned by the network-isolated worker container.

The API contract is documented in [`../../deploy/markitdown/README.md`](../../deploy/markitdown/README.md).
The service is not a durable source of record: uploaded documents, results, and task rows are
deleted by TTL. The calling workstation must retain the source document and downloaded result.

## Conversion fidelity

- `DOCX` and `PPTX` use the `fallback-assets-v2` profile. MarkItDown data URIs are decoded
  immediately into content-addressed `images/<sha256>.<ext>` entries and Markdown links are
  rewritten before the result leaves the worker.
- The v3 result manifest records each asset path, SHA-256, MIME type, byte size, plus OOXML
  relationship/reference counts. Repeated copies of identical image bytes share one asset while
  retaining every Markdown reference.
- SVG and unsupported embedded image formats are not published. The bundle records an omitted
  image warning; the workstation accepts it only in quick quality mode and rejects it in strict
  high-quality mode.
- `PDF` is deliberately text-only in this fallback service and always returns the
  `pdf_text_only_images_not_extracted` warning. Use MinerU when PDF images or OCR matter.

The workstation client selects the v3 profile from `/v1/health` and still accepts legacy
`markitdown-result/v2` bundles. Previously imported Source Text is not mutated automatically:
documents with broken image links or missing H1 should be explicitly re-converted after the v3
service is deployed.

## Local development

```bash
uv sync
uv run pytest
uv run ruff check .
```

Do not run the API with an internet-facing bind. The supported deployment publishes the container
port only on the host loopback interface and puts authentication in front of every `/v1` route.
