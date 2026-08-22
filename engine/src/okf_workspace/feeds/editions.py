"""Materialize disposable full-edition reading notes only when opened."""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
from datetime import datetime
from pathlib import Path

from okf_workspace.okf.frontmatter import OkfDocument, read_document, write_document
from okf_workspace.okf.paths import slugify

from .models import FeedComment, FeedEdition, FeedItem, FeedKind

_DATA_IMAGE = re.compile(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$", re.DOTALL)
_IMAGE_EXTENSIONS = {
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}
_MAX_FEED_MEDIA_BYTES = 25 * 1024 * 1024


def item_block_id(item: FeedItem) -> str:
    if item.feed is FeedKind.TREEHOLE and item.pid is not None:
        return f"treehole-{item.pid}"
    digest = hashlib.sha256(item.item_id.encode("utf-8")).hexdigest()[:12]
    return f"feed-{digest}"


def _ai_daily_body(edition: FeedEdition) -> str:
    sections = [f"# {edition.title}\n"]
    for item in edition.items:
        sections.append(f"## {item.title}\n")
        metadata: list[str] = []
        if item.published_at:
            metadata.append(f"- 发布时间：{item.published_at}")
        if item.url:
            metadata.append(f"- 原文：{item.url}")
        if metadata:
            sections.append("\n".join(metadata) + "\n")
        sections.append(item.body.strip() + "\n")
        sections.append(f"^{item_block_id(item)}\n")
    return "\n".join(sections)


def materialize_media_references(vault: Path, item: FeedItem) -> tuple[str, ...]:
    """Move preview-only data URIs into excluded Vault assets when explicitly opened/selected."""

    references: list[str] = []
    for value in item.media:
        match = _DATA_IMAGE.fullmatch(value)
        if match is None:
            references.append(value)
            continue
        mime = match.group(1).casefold()
        try:
            content = base64.b64decode(match.group(2), validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("Feed media contains invalid base64") from exc
        if len(content) > _MAX_FEED_MEDIA_BYTES:
            raise ValueError("Feed media exceeds 25 MiB")
        extension = _IMAGE_EXTENSIONS.get(mime, ".bin")
        digest = hashlib.sha256(content).hexdigest()
        relative = (
            Path("sources")
            / "assets"
            / "treehole-media"
            / slugify(item.edition_id)
            / f"{digest}{extension}"
        )
        target = vault.resolve() / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.is_file():
            target.write_bytes(content)
        references.append("/" + relative.as_posix())
    return tuple(references)


def _format_comment_time(value: str | None) -> str | None:
    if not value:
        return None
    try:
        # Keep the timestamp's declared offset. Converting through the host
        # timezone makes the same Digest render differently on Windows and CI.
        return datetime.fromisoformat(value.replace("Z", "+00:00")).strftime(
            "%Y-%m-%d %H:%M"
        )
    except ValueError:
        return value


def _reply_excerpt(value: str | None, *, limit: int = 120) -> str | None:
    if not value:
        return None
    compact = " ".join(value.split())
    if not compact:
        return None
    return compact if len(compact) <= limit else compact[: limit - 1].rstrip() + "…"


def _comment_reply_line(
    comment: FeedComment,
    positions: dict[int, tuple[int, FeedComment]],
) -> str | None:
    if comment.reply_to_cid is None:
        return None
    known = positions.get(comment.reply_to_cid)
    if known is not None:
        index, parent = known
        author = parent.author or comment.reply_to_author or "匿名"
        target = f"{index}. {author}"
        excerpt = _reply_excerpt(parent.text) or _reply_excerpt(comment.reply_to_text)
    else:
        target = comment.reply_to_author or "未抓取的评论"
        excerpt = _reply_excerpt(comment.reply_to_text)
    reference = f"回复 {target} (CID {comment.reply_to_cid})"
    return f"↳ {reference}：「{excerpt}」" if excerpt else f"↳ {reference}"


def render_treehole_comments(vault: Path, item: FeedItem) -> str:
    lines = [f"> [!comments]- 已抓取评论 ({len(item.comments)} 条，默认折叠)"]
    if not item.comments:
        return "\n".join([*lines, ">", "> 当前批次没有保存到评论正文。"])
    positions = {
        comment.cid: (index, comment)
        for index, comment in enumerate(item.comments, start=1)
        if comment.cid is not None
    }
    for index, comment in enumerate(item.comments, start=1):
        metadata = [f"{index}. {comment.author or '匿名'}"]
        if comment.is_original_poster and comment.author != "洞主":
            metadata.append("洞主")
        comment_time = _format_comment_time(comment.published_at)
        if comment_time:
            metadata.append(comment_time)
        if comment.cid is not None:
            metadata.append(f"CID {comment.cid}")
        lines.extend([">", f"> **{' · '.join(metadata)}**", ">"])
        reply_line = _comment_reply_line(comment, positions)
        if reply_line:
            lines.extend([f"> {reply_line}", ">"])
        lines.extend(f"> {line}" if line else ">" for line in comment.text.splitlines() or [""])
        if comment.media:
            comment_item = FeedItem(
                item_id=item.item_id,
                feed=item.feed,
                edition_id=item.edition_id,
                title=item.title,
                body="",
                pid=item.pid,
                media=comment.media,
            )
            for media in materialize_media_references(vault, comment_item):
                lines.extend([">", f"> ![]({media})"])
    return "\n".join(lines)


def _treehole_metrics_line(item: FeedItem) -> str | None:
    if not item.metrics:
        return None
    metrics = " · ".join(f"{key}: {value}" for key, value in sorted(item.metrics.items()))
    return f"- 指标：{metrics}"


def _treehole_body(vault: Path, edition: FeedEdition) -> str:
    sections = [f"# {edition.title}\n"]
    for item in edition.items:
        sections.append(f"## {item.title}\n")
        if item.published_at:
            sections.append(f"- 时间：{item.published_at}\n")
        metrics_line = _treehole_metrics_line(item)
        if metrics_line is not None:
            sections.append(metrics_line + "\n")
        sections.append(item.body.strip() + "\n")
        media = materialize_media_references(vault, item)
        if media:
            sections.append("### 媒体\n")
            sections.extend(f"![]({value})\n" for value in media)
        # The navigation target and decision widget belong to the item itself,
        # not to the potentially very long folded comment thread below it.
        sections.append(f"^{item_block_id(item)}\n")
        if item.comments:
            sections.extend([render_treehole_comments(vault, item), ""])
    return "\n".join(sections)


def edition_relative_path(edition: FeedEdition) -> Path:
    year = edition.edition_at[:4]
    if len(year) != 4 or not year.isdigit():
        raise ValueError(f"edition date must start with a year: {edition.edition_at!r}")
    if edition.feed is FeedKind.AI_DAILY:
        stream = slugify(edition.stream or "edition")
        return Path("feeds") / "ai-daily" / year / f"{edition.edition_at[:10]}-{stream}.md"
    return Path("feeds") / "treehole" / year / f"{slugify(edition.edition_id)}.md"


def materialize_edition(vault: Path, edition: FeedEdition) -> Path:
    """Create/update the derived edition; this never creates Source records."""
    target = vault.resolve() / edition_relative_path(edition)
    if target.is_file():
        if edition.feed is FeedKind.TREEHOLE:
            content = target.read_text(encoding="utf-8")
            expected_blocks = {item_block_id(item) for item in edition.items}
            actual_blocks = set(re.findall(r"(?m)^\^([^\s]+)[ \t]*$", content))
            if expected_blocks.issubset(actual_blocks):
                _refresh_treehole_managed_blocks(vault, target, edition)
            else:
                # A Digest is a rebuildable projection. If an interrupted
                # historical migration left it structurally incomplete, restore
                # the full edition while retaining any custom frontmatter fields.
                existing = read_document(target)
                created_at = existing.frontmatter.get("created_at")
                existing.frontmatter.update(
                    _edition_frontmatter(
                        edition,
                        created_at=created_at if isinstance(created_at, str) else None,
                    )
                )
                write_document(
                    target,
                    OkfDocument(existing.frontmatter, _treehole_body(vault, edition)),
                )
        return target
    write_document(
        target,
        OkfDocument(
            _edition_frontmatter(edition),
            _ai_daily_body(edition)
            if edition.feed is FeedKind.AI_DAILY
            else _treehole_body(vault, edition),
        ),
    )
    return target


def _edition_frontmatter(
    edition: FeedEdition,
    *,
    created_at: str | None = None,
) -> dict[str, object]:
    fields: dict[str, object] = {
        "type": "Digest",
        "title": edition.title,
        "feed": edition.feed.value,
        "digest_id": edition.edition_id,
        "issued_at": edition.edition_at,
        "items": [
            {"id": item.item_id, "block_id": item_block_id(item)} for item in edition.items
        ],
        "created_at": created_at or datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    if edition.stream:
        fields["section"] = edition.stream
    return fields


def _refresh_treehole_managed_blocks(
    vault: Path,
    target: Path,
    edition: FeedEdition,
) -> None:
    """Refresh generated metrics/comments while preserving all user-authored text."""

    content = target.read_text(encoding="utf-8")
    updated = content
    for item in edition.items:
        block = re.search(
            rf"(?m)^\^{re.escape(item_block_id(item))}[ \t]*$",
            updated,
        )
        if block is None:
            continue
        headings = list(re.finditer(r"(?m)^## .+$", updated[: block.start()]))
        if not headings:
            continue
        start = headings[-1].start()
        next_heading = re.search(r"(?m)^## .+$", updated[block.end() :])
        end = block.end() + next_heading.start() if next_heading is not None else len(updated)
        original_section = updated[start:end]
        section = original_section
        metrics_line = _treehole_metrics_line(item)
        if metrics_line is not None:
            managed_metrics = re.compile(
                r"\A(?P<prefix>## [^\r\n]+\r?\n(?:[ \t]*\r?\n)*"
                r"(?:- 时间：[^\r\n]*\r?\n(?:[ \t]*\r?\n)*)?)"
                r"- 指标：[^\r\n]*"
            )
            section = managed_metrics.sub(
                lambda match, line=metrics_line: f"{match.group('prefix')}{line}",
                section,
                count=1,
            )
        comments = re.compile(
            r"(?m)^> \[!(?:note|comments)\]- (?:评论|已抓取评论)[^\r\n]*"
            r"(?:\r?\n>[^\r\n]*)*"
        )
        refreshed = comments.sub(render_treehole_comments(vault, item), section, count=1)
        refreshed = _move_treehole_anchor_before_comments(
            refreshed,
            item_block_id(item),
        )
        if refreshed != original_section:
            updated = updated[:start] + refreshed + updated[end:]
    if updated != content:
        target.write_text(updated, encoding="utf-8", newline="\n")


def _move_treehole_anchor_before_comments(section: str, block_id: str) -> str:
    """Normalize legacy sections whose navigation target followed the comments."""

    marker = re.search(rf"(?m)^\^{re.escape(block_id)}[ \t]*$", section)
    comments = re.search(r"(?m)^> \[!(?:note|comments)\]- ", section)
    if marker is None or comments is None or marker.start() < comments.start():
        return section
    without_marker = section[: marker.start()] + section[marker.end() :]
    comments = re.search(r"(?m)^> \[!(?:note|comments)\]- ", without_marker)
    if comments is None:
        return section
    prefix = without_marker[: comments.start()].rstrip()
    suffix = without_marker[comments.start() :].lstrip("\r\n")
    return f"{prefix}\n\n^{block_id}\n\n{suffix}"
