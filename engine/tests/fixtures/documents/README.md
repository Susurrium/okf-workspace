# Document conversion fixtures

These files are deterministic, privacy-safe parser fixtures for M7:

- `simple.docx`: title, real bullet list, hyperlink, and fixed-width table.
- `legacy.doc`: Word 97 copy of the DOCX fixture for COM normalization.
- `slides.pptx`: two slides with titles, bullets, speaker notes, and a raster image.
- `text.pdf`: two pages of directly extractable text.
- `scan.pdf`: image-only page for OCR routing.
- `two-column.pdf`: two columns plus a footnote.
- `formula.pdf`: formula text and a simple labeled chart.
- `broken.pdf`: intentionally damaged input.
- `duplicate.pdf`: byte-identical copy of `text.pdf` for Original deduplication.

Regenerate with the bundled Codex workspace runtimes. Generated render folders are QA
intermediates and are not committed.
