"""Safe Markdown fragments shared by Feed projections and Source supplements."""

from __future__ import annotations

from urllib.parse import quote


def markdown_link(label: str, url: str) -> str:
    """Render an external URL without exposing it to Markdown emphasis parsing."""

    normalized = quote(
        " ".join(url.strip().splitlines()),
        safe=":/?#[]@!$&'()*+,;=%~._-",
    )
    escaped_label = label.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")
    return f"[{escaped_label}](<{normalized}>)"
