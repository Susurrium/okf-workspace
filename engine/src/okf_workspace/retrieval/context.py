"""Re-open real Markdown for every final candidate before it reaches AI."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from okf_workspace.okf.paths import resolve_bundle_path

from .chunks import chunk_markdown, text_hash
from .index import SearchIndex
from .models import ContextItem, MarkdownChunk, SearchHit
from .scanner import file_hash, is_retrievable_markdown


def _actual_text(path: Path, start_line: int, end_line: int) -> str:
    lines = path.read_text(encoding="utf-8").replace("\r\n", "\n").splitlines()
    return "\n".join(lines[start_line - 1 : end_line]).strip()


def _replacement(hit: SearchHit, chunks: list[MarkdownChunk]) -> MarkdownChunk | None:
    exact = [
        chunk
        for chunk in chunks
        if chunk.heading == hit.heading and chunk.start_line == hit.start_line
    ]
    if exact:
        return exact[0]
    same_heading = [chunk for chunk in chunks if chunk.heading == hit.heading]
    if same_heading:
        return min(same_heading, key=lambda chunk: abs(chunk.start_line - hit.start_line))
    overlapping = [
        chunk for chunk in chunks if chunk.start_line <= hit.start_line <= chunk.end_line
    ]
    return overlapping[0] if overlapping else (chunks[0] if chunks else None)


class ContextReader:
    def __init__(self, index: SearchIndex) -> None:
        self.index = index

    def read_hit(self, hit: SearchHit) -> ContextItem:
        path = resolve_bundle_path(self.index.vault, hit.path)
        if not path.is_file():
            raise FileNotFoundError(path)
        if "explicit path" in hit.retrieval_reasons:
            chunks = chunk_markdown(
                hit.path,
                path.read_text(encoding="utf-8"),
                fallback_title=path.stem,
            )
            current = _replacement(hit, chunks)
            if current is None:
                raise RuntimeError(f"no readable Markdown section remains in {hit.path}")
            actual = _actual_text(path, current.start_line, current.end_line)
            current_hash = text_hash(actual)
            return ContextItem(
                path=hit.path,
                heading=current.heading,
                start_line=current.start_line,
                end_line=current.end_line,
                actual_text=actual,
                read_at=datetime.now(UTC),
                current_text_hash=current_hash,
                retrieval_reasons=hit.retrieval_reasons,
                refreshed_after_change=current_hash != hit.text_hash,
            )
        if not is_retrievable_markdown(path, self.index.vault):
            raise ValueError(f"{hit.path} is no longer a default retrieval source")
        indexed_file_hash = self.index.get_file_hash(hit.path)
        changed = indexed_file_hash != file_hash(path)
        current_hit = hit
        if changed:
            self.index.index_path(path, force=True)
            replacement = _replacement(hit, self.index.chunks_for_paths([hit.path]))
            if replacement is None:
                raise RuntimeError(f"no readable Markdown section remains in {hit.path}")
            current_hit = SearchHit(
                path=replacement.path,
                heading=replacement.heading,
                start_line=replacement.start_line,
                end_line=replacement.end_line,
                text_hash=replacement.text_hash,
                score=hit.score,
                retrieval_reasons=hit.retrieval_reasons,
            )
        actual = _actual_text(
            path,
            current_hit.start_line,
            current_hit.end_line,
        )
        current_hash = text_hash(actual)
        if current_hash != current_hit.text_hash:
            self.index.index_path(path, force=True)
            replacement = _replacement(
                current_hit,
                self.index.chunks_for_paths([current_hit.path]),
            )
            if replacement is None:
                raise RuntimeError(f"unable to refresh changed section in {hit.path}")
            current_hit = SearchHit(
                path=replacement.path,
                heading=replacement.heading,
                start_line=replacement.start_line,
                end_line=replacement.end_line,
                text_hash=replacement.text_hash,
                score=hit.score,
                retrieval_reasons=hit.retrieval_reasons,
            )
            actual = _actual_text(
                path,
                current_hit.start_line,
                current_hit.end_line,
            )
            current_hash = text_hash(actual)
            changed = True
        return ContextItem(
            path=current_hit.path,
            heading=current_hit.heading,
            start_line=current_hit.start_line,
            end_line=current_hit.end_line,
            actual_text=actual,
            read_at=datetime.now(UTC),
            current_text_hash=current_hash,
            retrieval_reasons=current_hit.retrieval_reasons,
            refreshed_after_change=changed,
        )

    def read(self, hits: list[SearchHit], *, limit: int = 6) -> list[ContextItem]:
        items: list[ContextItem] = []
        seen: set[tuple[str, str, int]] = set()
        for hit in hits:
            if hit.identity in seen:
                continue
            seen.add(hit.identity)
            items.append(self.read_hit(hit))
            if len(items) >= limit:
                break
        return items
