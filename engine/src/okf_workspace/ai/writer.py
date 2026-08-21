"""Recoverable AI writes constrained by OKF paths and managed regions."""

from __future__ import annotations

from pathlib import Path

from okf_workspace.git import create_checkpoint
from okf_workspace.notes import NoteService
from okf_workspace.notes.organize import replace_heading_section, replace_managed_region
from okf_workspace.okf.frontmatter import read_document, write_document
from okf_workspace.okf.paths import resolve_bundle_path, slugify

from .policy import Actor, authorize_write


class AIWriter:
    def __init__(self, vault: Path) -> None:
        self.vault = vault.resolve()

    def create_wiki(
        self,
        title: str,
        content: str,
        *,
        sources: tuple[str, ...],
    ) -> Path:
        create_checkpoint(self.vault, "checkpoint before explicit AI write")
        predicted = f"knowledge/wiki/{slugify(title)}.md"
        authorize_write(predicted, actor="explicit-ai", operation="create")
        path = NoteService(self.vault).create_wiki(
            title,
            content,
            sources=sources,
        )
        create_checkpoint(self.vault, f"ai: create Wiki {path.stem}")
        return path

    def replace_region(
        self,
        relative: str,
        region: str,
        content: str,
        *,
        actor: Actor,
    ) -> Path:
        authorize_write(
            relative,
            actor=actor,
            operation="replace-managed-region",
            managed_region=region,
        )
        path = resolve_bundle_path(self.vault, relative)
        create_checkpoint(self.vault, f"checkpoint before {actor} region update")
        current = path.read_text(encoding="utf-8")
        updated = replace_managed_region(current, region, content)
        path.write_text(updated, encoding="utf-8", newline="\n")
        create_checkpoint(self.vault, f"ai: update {relative} region {region}")
        return path

    def replace_section(
        self,
        relative: str,
        heading: str,
        content: str,
    ) -> Path:
        """Apply one explicit user-requested heading edit without rewriting the note."""

        authorize_write(relative, actor="explicit-ai", operation="edit-section")
        path = resolve_bundle_path(self.vault, relative)
        document = read_document(path)
        create_checkpoint(self.vault, "checkpoint before explicit AI section edit")
        document.body = replace_heading_section(document.body, heading, content)
        write_document(path, document)
        create_checkpoint(self.vault, f"ai: update {relative} section {heading}")
        return path
