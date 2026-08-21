#!/usr/bin/env python3
"""Generate the deterministic, non-sensitive PDF used by deployment verification."""

from __future__ import annotations

import argparse
from pathlib import Path

CANARY_TEXT = "Obsidian MarkItDown deployment canary"


def build_canary_pdf() -> bytes:
    """Return a small, valid one-page PDF containing ``CANARY_TEXT``."""

    content = (
        b"BT\n"
        b"/F1 12 Tf\n"
        b"72 720 Td\n"
        + f"({CANARY_TEXT}) Tj\n".encode("ascii")
        + b"ET\n"
    )
    objects = (
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"
        ),
        b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n"
        + content
        + b"endstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    )

    document = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, body in enumerate(objects, start=1):
        offsets.append(len(document))
        document.extend(f"{number} 0 obj\n".encode("ascii"))
        document.extend(body)
        document.extend(b"\nendobj\n")

    xref_offset = len(document)
    document.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    document.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        document.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    document.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode("ascii")
    )
    return bytes(document)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    output = args.output.resolve(strict=False)
    if output.exists():
        parser.error(f"refusing to overwrite an existing path: {output}")
    if not output.parent.is_dir() or output.parent.is_symlink():
        parser.error(f"output parent must be a regular existing directory: {output.parent}")
    with output.open("xb") as handle:
        handle.write(build_canary_pdf())
        handle.flush()
    output.chmod(0o600)
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
