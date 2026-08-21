"""Resolve durable Course and Project relationships from real Markdown sources."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from contextlib import suppress
from pathlib import Path
from typing import cast

from .frontmatter import OkfDocument, read_document
from .paths import resolve_bundle_path, slugify

CONTEXT_FIELDS = ("course", "project")

_CONTEXT_TARGETS: dict[str, tuple[str, str]] = {
    "course": ("Course", "learning/courses/{slug}/course.md"),
    "project": ("Project", "projects/{slug}/project.md"),
}


def _relative_reference(value: str) -> str | None:
    normalized = value.strip().replace("\\", "/")
    if not normalized or normalized.startswith("//"):
        return None
    return normalized.removeprefix("/")


def _linked_sources(document: OkfDocument) -> tuple[str, ...]:
    value = document.frontmatter.get("sources")
    if not isinstance(value, list):
        return ()
    paths: list[str] = []
    for item in cast(list[object], value):
        if not isinstance(item, Mapping):
            continue
        resource = cast(Mapping[object, object], item).get("resource")
        if not isinstance(resource, str):
            continue
        relative = _relative_reference(resource)
        if relative is not None:
            paths.append(relative)
    return tuple(dict.fromkeys(paths))


def normalize_context_reference(vault: Path, field: str, value: str) -> str:
    """Return one canonical Vault path and verify that it names the right artifact."""

    expected = _CONTEXT_TARGETS.get(field)
    if expected is None:
        raise ValueError(f"unsupported context field: {field}")
    expected_type, pattern = expected
    raw = value.strip()
    if not raw:
        raise ValueError(f"{field} cannot be empty")
    relative = _relative_reference(raw)
    if relative is None:
        raise ValueError(f"{field} must be a single Vault-relative reference")
    if "/" not in relative:
        relative = pattern.format(slug=slugify(relative))
    path = resolve_bundle_path(vault.resolve(), relative)
    if not path.is_file():
        raise FileNotFoundError(path)
    document = read_document(path)
    if document.type != expected_type:
        raise ValueError(f"{field} must reference a {expected_type}: {relative}")
    return f"/{path.relative_to(vault.resolve()).as_posix()}"


def explicit_context_fields(
    vault: Path,
    *,
    course: str | None = None,
    project: str | None = None,
) -> dict[str, str]:
    """Validate optional user-selected context without inventing a relationship."""

    fields: dict[str, str] = {}
    for name, value in (("course", course), ("project", project)):
        if value is not None:
            fields[name] = normalize_context_reference(vault, name, value)
    return fields


def inherited_context_fields(
    vault: Path,
    sources: Sequence[str],
    *,
    current: Mapping[str, object] | None = None,
) -> dict[str, str]:
    """Resolve Course/Project from explicit sources, preserving target fields first.

    Source order is authoritative.  The first source lineage containing any context is
    used as one unit, so unrelated sources cannot accidentally contribute one field
    each.  A single source may explicitly carry both fields.  A Source ``uses`` list
    is inherited only when it identifies one distinct non-empty context; multi-use
    ambiguity must be resolved by explicit workflow context.  Missing or external
    references are ignored so a legacy note remains readable; no title/body guessing
    is performed.
    """

    root = vault.resolve()
    result: dict[str, str] = {}
    if current is not None:
        for field in CONTEXT_FIELDS:
            value = current.get(field)
            if isinstance(value, str) and value.strip():
                # An explicit target field wins even if the referenced note is
                # temporarily unavailable.  Validation remains responsible for
                # reporting a broken reference.
                result[field] = value.strip()
    if len(result) == len(CONTEXT_FIELDS):
        return result

    def unambiguous_use_context(document: OkfDocument) -> dict[str, str]:
        raw = document.frontmatter.get("uses")
        if document.type != "Source" or not isinstance(raw, list):
            return {}
        candidates: list[dict[str, str]] = []
        for item in cast(list[object], raw):
            if not isinstance(item, Mapping):
                continue
            use = cast(Mapping[object, object], item)
            candidate: dict[str, str] = {}
            for field in CONTEXT_FIELDS:
                value = use.get(field)
                if not isinstance(value, str) or not value.strip():
                    continue
                with suppress(OSError, ValueError):
                    candidate[field] = normalize_context_reference(root, field, value)
            if candidate and candidate not in candidates:
                candidates.append(candidate)
        return candidates[0] if len(candidates) == 1 else {}

    def lineage_context(relative_value: str, visited: set[str]) -> dict[str, str]:
        relative = _relative_reference(relative_value)
        if relative is None or relative in visited:
            return {}
        visited.add(relative)
        with suppress(OSError, ValueError):
            path = resolve_bundle_path(root, relative)
            if not path.is_file():
                return {}
            document = read_document(path)
            direct: dict[str, str] = {}
            for field in CONTEXT_FIELDS:
                value = document.frontmatter.get(field)
                if not isinstance(value, str) or not value.strip():
                    continue
                with suppress(OSError, ValueError):
                    direct[field] = normalize_context_reference(root, field, value)
            if direct:
                return direct
            if use_context := unambiguous_use_context(document):
                return use_context
            for linked in _linked_sources(document):
                inherited = lineage_context(linked, visited)
                if inherited:
                    return inherited
        return {}

    for source in sources:
        inherited = lineage_context(source, set())
        if not inherited:
            continue
        for field, value in inherited.items():
            result.setdefault(field, value)
        # Relationships from separate top-level sources must not be combined.
        if inherited:
            break
    return result


def source_paths(document: OkfDocument) -> tuple[str, ...]:
    """Expose local ``sources`` paths for deterministic relationship propagation."""

    return _linked_sources(document)
