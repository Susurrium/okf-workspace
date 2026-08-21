"""Parse and write OKF Markdown without discarding extension fields."""

from __future__ import annotations

import os
import tempfile
from collections.abc import Callable, Mapping, MutableMapping
from dataclasses import dataclass
from io import StringIO
from pathlib import Path
from typing import Any, cast

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap


class FrontmatterError(ValueError):
    """Raised when an OKF concept has malformed frontmatter."""


@dataclass(slots=True)
class OkfDocument:
    frontmatter: MutableMapping[str, Any]
    body: str

    @property
    def type(self) -> str:
        value = self.frontmatter.get("type")
        return value.strip() if isinstance(value, str) else ""


def _yaml() -> YAML:
    yaml = YAML(typ="rt")
    yaml.preserve_quotes = True
    yaml.default_flow_style = False
    yaml.allow_duplicate_keys = False
    return yaml


def parse_document(text: str, *, source: str = "<memory>") -> OkfDocument:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = normalized.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        raise FrontmatterError(f"{source}: concept must start with YAML frontmatter")

    closing: int | None = None
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            closing = index
            break
    if closing is None:
        raise FrontmatterError(f"{source}: frontmatter has no closing delimiter")

    yaml_text = "".join(lines[1:closing])
    try:
        loader = cast(Callable[[str], object], _yaml().load)  # pyright: ignore[reportUnknownMemberType]
        loaded: object = loader(yaml_text)
    except Exception as exc:  # ruamel exposes several parser-specific error types
        raise FrontmatterError(f"{source}: invalid YAML frontmatter: {exc}") from exc
    if loaded is None:
        loaded = CommentedMap()
    if not isinstance(loaded, MutableMapping):
        raise FrontmatterError(f"{source}: frontmatter must be a YAML mapping")

    frontmatter = cast(MutableMapping[str, Any], loaded)
    return OkfDocument(frontmatter=frontmatter, body="".join(lines[closing + 1 :]))


def read_document(path: Path) -> OkfDocument:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise FrontmatterError(f"{path}: file is not UTF-8") from exc
    return parse_document(text, source=str(path))


def render_document(
    frontmatter: Mapping[str, Any] | MutableMapping[str, Any],
    body: str,
) -> str:
    mapping = (
        frontmatter
        if isinstance(frontmatter, MutableMapping)
        else CommentedMap(frontmatter.items())
    )
    stream = StringIO()
    dumper = cast(
        Callable[[object, StringIO], None],
        _yaml().dump,  # pyright: ignore[reportUnknownMemberType]
    )
    dumper(mapping, stream)
    normalized_body = body.replace("\r\n", "\n").replace("\r", "\n")
    if normalized_body and not normalized_body.startswith("\n"):
        normalized_body = "\n" + normalized_body
    if normalized_body and not normalized_body.endswith("\n"):
        normalized_body += "\n"
    return f"---\n{stream.getvalue()}---\n{normalized_body}"


def write_document(
    path: Path,
    document: OkfDocument,
    *,
    create_only: bool = False,
) -> None:
    if create_only and path.exists():
        raise FileExistsError(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    content = render_document(document.frontmatter, document.body)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        if create_only and path.exists():
            raise FileExistsError(path)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
