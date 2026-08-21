# Obsidian MarkItDown fallback service

This subproject is a deliberately narrow boundary around MarkItDown. It accepts only a raw PDF,
PPTX, or DOCX request body, never accepts a URI or server-side path, disables plugins, and runs each
conversion in a time-limited child process owned by the network-isolated worker container.

The API contract is documented in [`../../deploy/markitdown/README.md`](../../deploy/markitdown/README.md).
The service is not a durable source of record: uploaded documents, results, and task rows are
deleted by TTL. The calling workstation must retain the source document and downloaded result.

## Local development

```bash
uv sync
uv run pytest
uv run ruff check .
```

Do not run the API with an internet-facing bind. The supported deployment publishes the container
port only on the host loopback interface and puts authentication in front of every `/v1` route.
