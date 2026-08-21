"""Split Markdown by structure while keeping complex blocks intact."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

from .models import MarkdownChunk

_HEADING = re.compile(r"^(#{1,3})\s+(.+?)\s*$")
_FENCE = re.compile(r"^\s*([`]{3,}|~{3,})")
_HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)


@dataclass(frozen=True, slots=True)
class _Line:
    number: int
    text: str


@dataclass(frozen=True, slots=True)
class _Section:
    heading: str
    lines: tuple[_Line, ...]


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _has_substantive_content(text: str) -> bool:
    """Exclude sections made only of headings and managed-region markers."""

    without_comments = _HTML_COMMENT.sub("", text)
    without_headings = "\n".join(
        line for line in without_comments.splitlines() if not _HEADING.match(line)
    )
    return bool(without_headings.strip())


def _body_lines(markdown: str) -> list[_Line]:
    lines = markdown.replace("\r\n", "\n").replace("\r", "\n").splitlines()
    if not lines or lines[0].strip() != "---":
        return [_Line(index, line) for index, line in enumerate(lines, start=1)]
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return [
                _Line(number, value)
                for number, value in enumerate(lines[index + 1 :], start=index + 2)
            ]
    return [_Line(index, line) for index, line in enumerate(lines, start=1)]


def _sections(markdown: str, fallback_title: str) -> list[_Section]:
    headings: list[tuple[int, str]] = []
    current: list[_Line] = []
    sections: list[_Section] = []
    in_fence = False
    fence: str | None = None

    def flush() -> None:
        nonlocal current
        if not current:
            return
        title = " > ".join(value for _, value in headings) or fallback_title
        sections.append(_Section(title, tuple(current)))
        current = []

    for line in _body_lines(markdown):
        fence_match = _FENCE.match(line.text)
        if fence_match:
            marker = fence_match.group(1)[0]
            if not in_fence:
                in_fence = True
                fence = marker
            elif marker == fence:
                in_fence = False
                fence = None
            current.append(line)
            continue
        heading_match = None if in_fence else _HEADING.match(line.text)
        if heading_match:
            flush()
            level = len(heading_match.group(1))
            title = heading_match.group(2).strip()
            headings[:] = [item for item in headings if item[0] < level]
            headings.append((level, title))
        current.append(line)
    flush()
    return sections


def _blocks(lines: tuple[_Line, ...]) -> list[list[_Line]]:
    blocks: list[list[_Line]] = []
    current: list[_Line] = []
    in_fence = False
    fence: str | None = None
    for line in lines:
        fence_match = _FENCE.match(line.text)
        if fence_match:
            marker = fence_match.group(1)[0]
            if not in_fence:
                in_fence = True
                fence = marker
            elif marker == fence:
                in_fence = False
                fence = None
            current.append(line)
            continue
        if not in_fence and not line.text.strip():
            if current:
                blocks.append(current)
                current = []
            continue
        current.append(line)
    if current:
        blocks.append(current)
    return blocks


def _windows(
    blocks: list[list[_Line]],
    *,
    max_chars: int,
    overlap_ratio: float,
) -> list[list[_Line]]:
    if not blocks:
        return []
    windows: list[list[_Line]] = []
    index = 0
    while index < len(blocks):
        window: list[_Line] = []
        end = index
        while end < len(blocks):
            candidate = window + blocks[end]
            length = sum(len(line.text) + 1 for line in candidate)
            if window and length > max_chars:
                break
            window = candidate
            end += 1
            if length >= max_chars:
                break
        windows.append(window)
        if end >= len(blocks):
            break
        overlap_chars = max(1, int(max_chars * overlap_ratio))
        retained = 0
        next_index = end
        for previous in range(end - 1, index - 1, -1):
            retained += sum(len(line.text) + 1 for line in blocks[previous])
            next_index = previous
            if retained >= overlap_chars:
                break
        index = next_index if next_index > index else end
    return windows


def chunk_markdown(
    path: str,
    markdown: str,
    *,
    fallback_title: str,
    max_chars: int = 3200,
    overlap_ratio: float = 0.12,
) -> list[MarkdownChunk]:
    chunks: list[MarkdownChunk] = []
    for section in _sections(markdown, fallback_title):
        for part, lines in enumerate(
            _windows(
                _blocks(section.lines),
                max_chars=max_chars,
                overlap_ratio=overlap_ratio,
            ),
            start=1,
        ):
            if not lines:
                continue
            text = "\n".join(line.text for line in lines).strip()
            if not text or not _has_substantive_content(text):
                continue
            start_line = lines[0].number
            end_line = lines[-1].number
            heading = section.heading if part == 1 else f"{section.heading} (续 {part})"
            identity = f"{path}:{start_line}:{end_line}:{text_hash(text)[:12]}"
            chunks.append(
                MarkdownChunk(
                    chunk_id=identity,
                    path=path,
                    heading=heading,
                    start_line=start_line,
                    end_line=end_line,
                    text=text,
                    text_hash=text_hash(text),
                )
            )
    return chunks
