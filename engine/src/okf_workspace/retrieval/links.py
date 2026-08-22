"""Extract one-hop Markdown, wiki, and OKF source links."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from pathlib import PurePosixPath
from typing import Any, cast

_MARKDOWN_LINK = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
_WIKI_LINK = re.compile(r"\[\[([^|\]#]+)(?:[|#][^\]]*)?\]\]")


def normalize_target(raw: str, source_path: str) -> str | None:
    value = raw.strip().strip("<>").split("#", 1)[0].replace("\\", "/")
    if not value or "://" in value or value.startswith(("mailto:", "data:")):
        return None
    if value.startswith("/"):
        target = PurePosixPath(value[1:])
    else:
        target = PurePosixPath(source_path).parent / value
    parts: list[str] = []
    for part in target.parts:
        if part in {"", ".", "/"}:
            continue
        if part == "..":
            if not parts:
                return None
            parts.pop()
        else:
            parts.append(part)
    return PurePosixPath(*parts).as_posix() if parts else None


def _source_resources(frontmatter: Mapping[str, Any]) -> list[str]:
    sources = frontmatter.get("sources")
    if not isinstance(sources, Sequence) or isinstance(sources, (str, bytes)):
        return []
    resources: list[str] = []
    for source in cast(Sequence[object], sources):
        if isinstance(source, str):
            resources.append(source)
        elif isinstance(source, Mapping):
            mapping = cast(Mapping[object, object], source)
            resource = mapping.get("resource")
            if isinstance(resource, str):
                resources.append(resource)
    return resources


def _structured_resources(frontmatter: Mapping[str, Any]) -> list[tuple[str, str]]:
    resources: list[tuple[str, str]] = []
    for field in ("text", "extract", "course", "project"):
        value = frontmatter.get(field)
        if isinstance(value, str):
            resources.append((value, field))
    uses = frontmatter.get("uses")
    if isinstance(uses, Sequence) and not isinstance(uses, (str, bytes)):
        for item in cast(Sequence[object], uses):
            if not isinstance(item, Mapping):
                continue
            use = cast(Mapping[object, object], item)
            for field in ("course", "project"):
                value = use.get(field)
                if isinstance(value, str):
                    resources.append((value, field))
    return resources


def extract_links(
    body: str,
    *,
    source_path: str,
    frontmatter: Mapping[str, Any],
) -> set[tuple[str, str]]:
    links: set[tuple[str, str]] = set()
    for raw in _MARKDOWN_LINK.findall(body):
        target = normalize_target(raw, source_path)
        if target:
            links.add((target, "markdown"))
    for raw in _WIKI_LINK.findall(body):
        candidate = raw if raw.endswith(".md") else f"{raw}.md"
        if "/" in candidate and not candidate.startswith("/"):
            candidate = f"/{candidate}"
        target = normalize_target(candidate, source_path)
        if target:
            links.add((target, "wiki"))
    for raw in _source_resources(frontmatter):
        target = normalize_target(raw, source_path)
        if target:
            links.add((target, "source"))
    for raw, relation in _structured_resources(frontmatter):
        target = normalize_target(raw, source_path)
        if target:
            links.add((target, relation))
    return links
