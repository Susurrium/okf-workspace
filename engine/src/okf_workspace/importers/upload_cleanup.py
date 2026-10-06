"""Compatibility guard for the retired external-original cleanup workflow."""
from __future__ import annotations

import re
from urllib.parse import unquote

from .pipeline import DocumentImporter


def references_attachment(text: str, relative: str, filename: str) -> bool:
    """Conservative guard, including URL-encoded and note-relative attachment links."""
    decoded = unquote(text).replace("\\", "/")
    if relative.casefold() in decoded.casefold():
        return True
    for wiki, markdown in re.findall(r"\[\[([^\]\n]+)\]\]|\]\(([^)\n]+)\)", decoded):
        target = (wiki or markdown).split("|", 1)[0].split("#", 1)[0].strip().strip("<>")
        if ":" in target and not target.casefold().startswith("file:"):
            continue
        leaf = target.rsplit("/", 1)[-1].casefold()
        if leaf == filename.casefold() or (wiki and leaf == filename.rsplit(".", 1)[0].casefold()):
            return True
    return False



def cleanup_uploads(importer: DocumentImporter, *, apply: bool = False) -> list[dict[str, str]]:
    """Old callers must never delete synced originals or contact a file service."""
    raise ValueError("已改为 Vault 全量同步；旧版上传副本清理已停用")
