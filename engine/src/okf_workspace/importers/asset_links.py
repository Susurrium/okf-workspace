"""Find and rewrite parser-output dependencies without changing surrounding Markdown."""

from __future__ import annotations

import html
import posixpath
import re
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from urllib.parse import quote, unquote

from .archive_paths import safe_relative_path

_CODE = re.compile(
    r"(?m)^ {0,3}(?P<fence>`{3,}|~{3,})[^\n]*\n"
    r"[\s\S]*?^ {0,3}(?P=fence)[ \t]*(?:\n|$)"
    r"|<!--[\s\S]*?-->|(?P<ticks>`+)[^`]*(?P=ticks)"
)
_INLINE = re.compile(r"(?<!\\)\]\([ \t]*")
_DEFINITION = re.compile(r"(?m)^ {0,3}\[(?P<label>[^\]\n]+)\]:[ \t]*")
_USE = re.compile(r"(?P<image>!)?\[(?P<label>[^\]\n]+)\](?:\[(?P<id>[^\]\n]*)\])?")
_WIKI = re.compile(r"(?P<image>!)?\[\[(?P<target>[^\]|\n]+)(?:\|[^\]\n]*)?\]\]")
_HTML = re.compile(r"<(?:img|a)\b(?:[^>\"']|\"[^\"]*\"|'[^']*')*>", re.IGNORECASE)
_ATTRIBUTE = re.compile(
    r"\b(?P<name>src|href)\s*=\s*(?:\"(?P<double>[^\"]*)\""
    r"|'(?P<single>[^']*)'|(?P<bare>[^\s>]+))", re.IGNORECASE,
)
_ESCAPE = re.compile(r"\\([!\"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])")


@dataclass(frozen=True)
class AssetLink:
    start: int
    end: int
    target: str
    image: bool
    wiki: bool = False

    @property
    def path(self) -> str | None:
        value = html.unescape(_ESCAPE.sub(r"\1", self.target)).replace("\\", "/")
        if not value or re.match(r"(?:[a-zA-Z][\w+.-]*:|//|#)", value):
            return None
        value = unquote(re.split(r"[?#]", value, maxsplit=1)[0])
        return posixpath.normpath(value.removeprefix("/"))


def _destination(text: str, start: int) -> tuple[int, int] | None:
    """Read angle-delimited or balanced/escaped Markdown link destinations."""
    if start >= len(text):
        return None
    if text[start] == "<":
        end = text.find(">", start + 1)
        return (start + 1, end) if end >= 0 and "\n" not in text[start:end] else None
    depth = 0
    end = start
    while end < len(text):
        char = text[end]
        if char == "\\" and end + 1 < len(text):
            end += 2
            continue
        if char.isspace() or (char == ")" and depth == 0):
            break
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        end += 1
    return (start, end) if end > start else None


def _image_label(text: str, closing: int) -> bool | None:
    depth = 1
    for index in range(closing - 1, -1, -1):
        if index and text[index - 1] == "\\":
            continue
        if text[index] == "]":
            depth += 1
        elif text[index] == "[":
            depth -= 1
            if not depth:
                return index > 0 and text[index - 1] == "!"
    return None


def asset_links(markdown: str) -> tuple[AssetLink, ...]:
    # Keep offsets stable so code samples and captions survive byte-for-byte.
    visible = _CODE.sub(
        lambda match: re.sub(r"[^\n]", " ", match.group()), markdown,
    )
    links: list[AssetLink] = []
    definitions = list(_DEFINITION.finditer(visible))
    uses: dict[str, bool] = {}
    for match in _USE.finditer(visible):
        if visible[match.end():match.end() + 1] in {"(", ":"}:
            continue
        label = " ".join((match.group("id") or match.group("label")).split()).casefold()
        uses[label] = uses.get(label, False) or bool(match.group("image"))
    for match in _INLINE.finditer(visible):
        is_image = _image_label(visible, match.start())
        if is_image is None:
            continue
        span = _destination(visible, match.end())
        if span:
            start, end = span
            links.append(AssetLink(start, end, markdown[start:end], is_image))
    for match in definitions:
        label = " ".join(match.group("label").split()).casefold()
        if label not in uses:
            continue
        span = _destination(visible, match.end())
        if span:
            start, end = span
            links.append(AssetLink(start, end, markdown[start:end], uses[label]))
    for match in _WIKI.finditer(visible):
        start, end = match.span("target")
        links.append(AssetLink(start, end, markdown[start:end], bool(match.group("image")), True))
    for tag in _HTML.finditer(visible):
        for match in _ATTRIBUTE.finditer(tag.group()):
            group = next(name for name in ("double", "single", "bare") if match[name] is not None)
            start, end = match.span(group)
            start, end = start + tag.start(), end + tag.start()
            links.append(AssetLink(start, end, markdown[start:end], match["name"].lower() == "src"))
    # HTML inside an inline destination must not introduce overlapping edits.
    result: list[AssetLink] = []
    for link in sorted(links, key=lambda item: (item.start, -item.end)):
        if not result or link.start >= result[-1].end:
            result.append(link)
    return tuple(result)


def resolve_asset_path(link: AssetLink, paths: Collection[str]) -> str | None:
    path = link.path
    if path is not None and link.wiki and "/" not in path and path not in paths:
        matches = [candidate for candidate in paths if posixpath.basename(candidate) == path]
        if len(matches) == 1:
            return matches[0]
    return path


def referenced_assets(markdown: str, assets: Mapping[str, bytes]) -> dict[str, bytes]:
    # Validate even unused exports; filtering must not conceal unsafe parser paths.
    normalized = {safe_relative_path(path).as_posix(): data for path, data in assets.items()}
    paths = {resolve_asset_path(link, normalized) for link in asset_links(markdown)}
    return {path: data for path, data in normalized.items() if path in paths}


def rewrite_asset_links(markdown: str, mapping: Mapping[str, str]) -> str:
    for link in reversed(asset_links(markdown)):
        target = mapping.get(resolve_asset_path(link, mapping) or "")
        if target is None:
            continue
        suffix = re.search(r"[?#].*$", link.target)
        replacement = target if link.wiki else quote(target, safe="/")
        if suffix:
            replacement += suffix.group()
        markdown = markdown[:link.start] + replacement + markdown[link.end:]
    return markdown
