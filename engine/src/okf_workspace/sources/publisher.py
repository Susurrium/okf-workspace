"""Publish and query one durable, context-neutral Source pair.

Entry channels construct their own provenance and text representation, but all
of them use this boundary for path validation, lookup, pair writes, and rollback.
Identity fields remain context-neutral. Human-selected uses are stored as an
idempotent list so they remain durable without turning Source into a state machine.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Generator, Mapping, Sequence
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from okf_workspace.okf.file_io import FileWriteConflict, atomic_write_bytes, document_lock
from okf_workspace.okf.frontmatter import (
    OkfDocument,
    parse_document,
    render_document,
    write_document,
)
from okf_workspace.okf.paths import resolve_bundle_path
from okf_workspace.okf.relations import explicit_context_fields
from okf_workspace.okf.validator import validate_document

from .lookup import source_lookup

ResourceNormalizer = Callable[[str], str]

_SOURCE_PURPOSES = {"study", "wiki", "reference", "undecided"}
_SOURCE_USE_FIELDS = {"purpose", "course", "project"}


@contextmanager
def source_write_lock(vault: Path) -> Generator[None]:
    """Serialize Source identity lookup and mutations across API/CLI processes.

    The virtual path is only a lock identity; the lock file lives outside Vault.
    """

    with document_lock(vault.resolve() / ".source-identity"):
        yield


@dataclass(frozen=True, slots=True)
class PublishedSourcePair:
    source: Path
    source_text: Path


def restore_file_bytes(
    path: Path,
    previous: bytes | None,
    *,
    expected_sha256: str | None = None,
) -> None:
    """Atomically restore a Source authority file after a pair-write failure."""

    with document_lock(path):
        if previous is None:
            if expected_sha256 is not None and (
                not path.is_file()
                or hashlib.sha256(path.read_bytes()).hexdigest() != expected_sha256
            ):
                raise FileWriteConflict(f"File changed before rollback: {path}")
            path.unlink(missing_ok=True)
            return
        atomic_write_bytes(path, previous, expected_sha256=expected_sha256)


class SourcePublisher:
    """The only low-level writer and resolver for Source/Source Text pairs."""

    def __init__(self, vault: Path) -> None:
        self.vault = vault.resolve()
        self.records_root = (self.vault / "sources" / "records").resolve()
        self.text_root = (self.vault / "sources" / "text").resolve()
        self._snapshots: dict[Path, bytes] = {}
        self._lookup = source_lookup(self.records_root)

    def read_record(self, path: Path) -> OkfDocument:
        """Read exactly the bytes whose version must still exist at publication."""

        resolved = path.resolve()
        payload = resolved.read_bytes()
        document = parse_document(payload.decode("utf-8"), source=str(resolved))
        self._snapshots[resolved] = payload
        return document

    def publish_record(self, source: Path, document: OkfDocument) -> Path:
        """Publish metadata independently of optional extracted text."""
        source = source.resolve()
        if not source.is_relative_to(self.records_root) or document.type != "Source":
            raise ValueError("Source record must be inside sources/records")
        report = validate_document(self.vault, source, document)
        if not report.valid:
            raise ValueError(f"Invalid Source: {report.issues}")
        if "text" in document.frontmatter:
            self.resolve_text(document)
        with self.transaction(), document_lock(source):
            previous = self._snapshots.get(source)
            write_document(
                source, document, create_only=previous is None,
                expected_sha256=hashlib.sha256(previous).hexdigest() if previous else None,
            )
            self._snapshots[source] = render_document(
                document.frontmatter, document.body,
            ).encode("utf-8")
            self._lookup.invalidate(source)
        return source

    @contextmanager
    def transaction(self) -> Generator[None]:
        """Keep lookup, latest read, merge and publication in one transaction."""

        with source_write_lock(self.vault):
            yield

    def update_use(
        self,
        source: Path,
        *,
        purpose: str,
        course: str | None = None,
        project: str | None = None,
    ) -> PublishedSourcePair:
        """Apply a human decision to the latest Source, never a caller snapshot."""

        source = source.resolve()
        if not source.is_relative_to(self.records_root):
            raise ValueError("only a Source Record can be routed")
        with self.transaction():
            document = self.read_record(source)
            source_text, text_document = self.resolve_text(document)
            self.resolve_use(document, purpose=purpose, course=course, project=project)
            return self.publish_pair(source, source_text, document, text_document)

    def find_by_resource(
        self,
        resource: str,
        *,
        normalize: ResourceNormalizer | None = None,
    ) -> tuple[Path, OkfDocument] | None:
        """Find a Source by exact or caller-normalized resource identity."""

        if not self.records_root.is_dir():
            return None
        expected = normalize(resource) if normalize is not None else resource
        for verify in (False, True):
            with self.transaction():
                candidates = self._lookup.candidates(
                    expected, by_hash=False, normalize=normalize, verify_content=verify,
                )
            if not candidates:
                return None
            for path in candidates:
                with suppress(OSError, ValueError):
                    payload = path.read_bytes()
                    document = parse_document(payload.decode("utf-8"), source=str(path))
                    current = document.frontmatter.get("resource")
                    if document.type != "Source" or not isinstance(current, str):
                        continue
                    identity = normalize(current) if normalize is not None else current
                    if identity == expected:
                        self._snapshots[path.resolve()] = payload
                        return path, document
        return None

    def find_by_sha256(self, digest: str) -> tuple[Path, OkfDocument] | None:
        """Find an imported file Source by immutable content identity."""

        value = digest.strip().casefold()
        if not value or not self.records_root.is_dir():
            return None
        for verify in (False, True):
            with self.transaction():
                candidates = self._lookup.candidates(value, by_hash=True, verify_content=verify)
            if not candidates:
                return None
            for path in candidates:
                with suppress(OSError, ValueError):
                    payload = path.read_bytes()
                    document = parse_document(payload.decode("utf-8"), source=str(path))
                    current = document.frontmatter.get("sha256")
                    if (
                        document.type == "Source"
                        and isinstance(current, str)
                        and current.casefold() == value
                    ):
                        self._snapshots[path.resolve()] = payload
                        return path, document
        return None

    def resolve_text(
        self,
        source: Path | OkfDocument,
    ) -> tuple[Path, OkfDocument]:
        """Resolve and validate the Source Text linked by one Source."""

        document = self.read_record(source) if isinstance(source, Path) else source
        if document.type != "Source":
            raise ValueError("Source Text can only be resolved from a Source")
        text_value = document.frontmatter.get("text")
        if not isinstance(text_value, str) or not text_value.strip():
            raise ValueError("Source has no Source Text link")
        source_text = resolve_bundle_path(self.vault, text_value.removeprefix("/"))
        if not source_text.is_relative_to(self.text_root):
            raise ValueError("Source Text link is outside sources/text")
        if not source_text.is_file():
            raise ValueError("Source Text link does not exist")
        text_document = self.read_record(source_text)
        if text_document.type != "Source Text":
            raise ValueError("Source text link does not point to a Source Text")
        return source_text, text_document

    def publish_pair(
        self,
        source: Path,
        source_text: Path,
        source_document: OkfDocument,
        text_document: OkfDocument,
    ) -> PublishedSourcePair:
        """Atomically publish a validated pair, restoring both files on failure."""

        source = source.resolve()
        source_text = source_text.resolve()
        self._validate_pair(source, source_text, source_document, text_document)
        with self.transaction(), document_lock(source), document_lock(source_text):
            previous_source = self._snapshots.get(source)
            if previous_source is None and source.is_file():
                previous_source = source.read_bytes()
            previous_text = self._snapshots.get(source_text)
            if previous_text is None and source_text.is_file():
                previous_text = source_text.read_bytes()
            text_written = False
            rendered_text = render_document(text_document.frontmatter, text_document.body).encode(
                "utf-8"
            )
            # Check both snapshots before mutating either half of the pair.
            for path, previous in ((source, previous_source), (source_text, previous_text)):
                if previous is not None and (not path.is_file() or path.read_bytes() != previous):
                    raise FileWriteConflict(f"Source changed after it was read: {path}")
            try:
                # Source points to Source Text, so make the target durable first.
                write_document(
                    source_text,
                    text_document,
                    create_only=previous_text is None,
                    expected_sha256=hashlib.sha256(previous_text).hexdigest()
                    if previous_text is not None
                    else None,
                )
                text_written = True
                write_document(
                    source,
                    source_document,
                    create_only=previous_source is None,
                    expected_sha256=hashlib.sha256(previous_source).hexdigest()
                    if previous_source is not None
                    else None,
                )
            except Exception:
                if text_written:
                    restore_file_bytes(
                        source_text,
                        previous_text,
                        expected_sha256=hashlib.sha256(rendered_text).hexdigest(),
                    )
                raise
            self._snapshots[source] = render_document(
                source_document.frontmatter, source_document.body
            ).encode("utf-8")
            self._snapshots[source_text] = rendered_text
            self._lookup.invalidate(source)
        return PublishedSourcePair(source=source, source_text=source_text)

    def add_use(
        self,
        document: OkfDocument,
        *,
        purpose: str,
        course: str | None = None,
        project: str | None = None,
    ) -> Mapping[str, str]:
        """Idempotently add one human-selected use to a shared Source."""

        if purpose not in _SOURCE_PURPOSES:
            raise ValueError(f"unsupported Source purpose: {purpose}")
        if document.type not in {"", "Source"}:
            raise ValueError("uses can only be recorded on a Source")
        use: dict[str, str] = {
            "purpose": purpose,
            **explicit_context_fields(self.vault, course=course, project=project),
        }
        raw = document.frontmatter.get("uses")
        if raw is None:
            uses: list[object] = []
        elif isinstance(raw, list):
            uses = list(cast(list[object], raw))
        else:
            raise ValueError("Source uses must be a list")
        if not any(
            isinstance(item, Mapping) and dict(cast(Mapping[object, object], item)) == use
            for item in uses
        ):
            uses.append(use)
        document.frontmatter["uses"] = uses
        return use

    def resolve_use(
        self,
        document: OkfDocument,
        *,
        purpose: str,
        course: str | None = None,
        project: str | None = None,
    ) -> Mapping[str, str]:
        """Record a decision and retire pending uses covered by its context.

        ``undecided`` is the absence of a decision for one context, not a second
        lasting use.  A later decision therefore removes an unscoped pending use
        or a pending use whose explicit context is a subset of the decision.
        Other context-specific pending uses remain intact.
        """

        resolved = dict(
            self.add_use(
                document,
                purpose=purpose,
                course=course,
                project=project,
            )
        )
        if purpose == "undecided":
            return resolved

        raw = cast(list[object], document.frontmatter["uses"])
        remaining: list[object] = []
        for item in raw:
            if not isinstance(item, Mapping):
                remaining.append(item)
                continue
            pending = cast(Mapping[object, object], item)
            if pending.get("purpose") != "undecided":
                remaining.append(pending)
                continue
            covered = all(
                pending.get(field) is None or pending.get(field) == resolved.get(field)
                for field in ("course", "project")
            )
            if not covered:
                remaining.append(pending)
        document.frontmatter["uses"] = remaining
        return resolved

    def _validate_pair(
        self,
        source: Path,
        source_text: Path,
        source_document: OkfDocument,
        text_document: OkfDocument,
    ) -> None:
        if source.suffix.casefold() != ".md" or not source.is_relative_to(self.records_root):
            raise ValueError("Source path must be inside sources/records")
        if source_text.suffix.casefold() != ".md" or not source_text.is_relative_to(self.text_root):
            raise ValueError("Source Text path must be inside sources/text")
        if source_document.type != "Source":
            raise ValueError("Source pair record must use type: Source")
        if text_document.type != "Source Text":
            raise ValueError("Source pair text must use type: Source Text")
        uses = source_document.frontmatter.get("uses")
        if not isinstance(uses, list) or not uses:
            raise ValueError("Source pair record must contain at least one use")
        for item in cast(list[object], uses):
            if not isinstance(item, Mapping):
                raise ValueError("each Source use must be a mapping")
            use = cast(Mapping[object, object], item)
            if set(use) - _SOURCE_USE_FIELDS:
                raise ValueError("Source use contains unsupported fields")
            if use.get("purpose") not in _SOURCE_PURPOSES:
                raise ValueError("Source use contains an unsupported purpose")
            for field in ("course", "project"):
                reference = use.get(field)
                if reference is None:
                    continue
                if not isinstance(reference, str) or not reference.startswith("/"):
                    raise ValueError(f"Source use {field} must be a Vault path")
                resolve_bundle_path(self.vault, reference.removeprefix("/"))

        linked = source_document.frontmatter.get("text")
        if not isinstance(linked, str) or not linked.strip():
            raise ValueError("Source pair record must link its Source Text")
        linked_path = resolve_bundle_path(self.vault, linked.removeprefix("/"))
        if linked_path != source_text:
            raise ValueError("Source pair record links a different Source Text")

        raw_sources = text_document.frontmatter.get("sources")
        if not isinstance(raw_sources, Sequence) or isinstance(raw_sources, (str, bytes)):
            raise ValueError("Source Text must link its Source record")
        linked_sources: list[Path] = []
        for entry in cast(Sequence[object], raw_sources):
            if not isinstance(entry, Mapping):
                continue
            resource = cast(Mapping[object, object], entry).get("resource")
            if isinstance(resource, str) and resource.startswith("/"):
                linked_sources.append(resolve_bundle_path(self.vault, resource.removeprefix("/")))
        if source not in linked_sources:
            raise ValueError("Source Text does not link its Source record")
