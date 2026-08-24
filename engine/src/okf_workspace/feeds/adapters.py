"""Normalize existing V1 AI Daily and treehole producer payloads."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from datetime import UTC, date, datetime
from typing import cast
from urllib.parse import urlparse, urlsplit, urlunsplit

from .models import FeedComment, FeedEdition, FeedItem, FeedKind

_AI_ITEM_HEADING = re.compile(
    r"^(?:(?P<marks>#{2,4})\s+)?\d+\.\s+\[(?P<title>.+)\]\((?P<url>https?://.+)\)\s*$"
)
_MARKDOWN_HEADING = re.compile(r"^(?P<marks>#{2,4})\s+(?P<title>.+?)\s*$")
_MARKDOWN_LINK = re.compile(r"\[(?P<label>[^]]+)\]\((?P<url>https?://[^)]+)\)")
_GENERIC_SOURCE_HEADINGS = {"来源", "最新条目"}
_AI_PAPERS_ISSUE = re.compile(
    r"(?m)^##\s+(?P<title>Top AI Papers of the Week[^\r\n]*)\s*$"
)
_AI_PAPERS_ROW = re.compile(
    r"^\|\s*(?P<rank>\d+)\)\s+\*\*(?P<title>.+?)\*\*\s+-\s+"
    r"(?P<description>.+?)\s+\|\s+(?P<links>.+?)\s+\|\s*$"
)
_AI_PAPERS_LINK = re.compile(
    r"\[Paper\]\((?P<url>https?://[^)\s]+)\)",
    re.IGNORECASE,
)
_AI_PAPERS_SOURCE_ID = "system:ai-papers-of-the-week"
_AI_PAPERS_SOURCE_NAME = "AI Papers of the Week"


def legacy_source_identity(source_name: str | None, url: str | None) -> str | None:
    """Reproduce the pre-registry Reading identity for cache migration."""

    if source_name:
        digest = hashlib.sha256(source_name.casefold().encode("utf-8")).hexdigest()[:16]
        return f"source:{digest}"
    hostname = urlparse(url).hostname if url else None
    return hostname.casefold() if hostname else None


def _source_heading(value: str) -> str | None:
    name = value.strip()
    return None if not name or name in _GENERIC_SOURCE_HEADINGS else name


def _frontmatter_value(markdown: str, key: str) -> str | None:
    lines = markdown.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for line in lines[1:]:
        if line.strip() == "---":
            break
        name, separator, value = line.partition(":")
        if separator and name.strip() == key:
            return value.strip().strip('"').strip("'")
    return None


def _plain_markdown(value: str) -> str:
    value = re.sub(r"<br\s*/?>", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"!\[[^]]*]\([^)]+\)", "", value)
    value = re.sub(r"\[([^]]+)]\([^)]+\)", r"\1", value)
    return re.sub(r"\s+", " ", value).strip()


def _canonical_paper_url(value: str) -> str:
    parsed = urlsplit(value)
    scheme = parsed.scheme.casefold()
    if scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("AI Papers paper URL must be HTTP(S)")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("AI Papers paper URL must not contain credentials")
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError("AI Papers paper URL has an invalid port") from error
    hostname = parsed.hostname.casefold()
    host = f"[{hostname}]" if ":" in hostname else hostname
    default_port = (scheme == "http" and port == 80) or (
        scheme == "https" and port == 443
    )
    netloc = host if port is None or default_port else f"{host}:{port}"
    return urlunsplit((scheme, netloc, parsed.path or "/", parsed.query, ""))


def ai_papers_markdown_from_v1(
    markdown: str,
    *,
    artifact_id: str,
) -> FeedEdition:
    """Convert one complete preserved AI Papers issue into a feed edition."""

    if not artifact_id or artifact_id.strip() != artifact_id:
        raise ValueError("AI Papers artifact id is invalid")
    issue_date = _frontmatter_value(markdown, "date")
    if not issue_date:
        raise ValueError("AI Papers Markdown has no date")
    try:
        parsed_date = date.fromisoformat(issue_date)
    except ValueError as error:
        raise ValueError("AI Papers Markdown date is invalid") from error
    if parsed_date.isoformat() != issue_date:
        raise ValueError("AI Papers Markdown date is invalid")
    issues = list(_AI_PAPERS_ISSUE.finditer(markdown))
    if len(issues) != 1:
        raise ValueError("AI Papers Markdown must contain exactly one issue")
    issue = issues[0]
    section = markdown[issue.start() :]
    parsed_rows: list[tuple[int, str, str, str]] = []
    for line in section.splitlines():
        row = _AI_PAPERS_ROW.fullmatch(line)
        if row is None:
            continue
        link = _AI_PAPERS_LINK.search(row.group("links"))
        if link is None:
            raise ValueError(f"AI Papers rank {row.group('rank')} has no Paper link")
        title = _plain_markdown(row.group("title"))
        description = _plain_markdown(row.group("description"))
        if not title or not description:
            raise ValueError("AI Papers row title and description are required")
        parsed_rows.append(
            (
                int(row.group("rank")),
                title,
                description,
                _canonical_paper_url(link.group("url")),
            )
        )
    ranks = [rank for rank, _title, _description, _url in parsed_rows]
    if not ranks or ranks != list(range(1, len(ranks) + 1)):
        raise ValueError("AI Papers issue ranks must be unique and continuous")
    paper_links = _AI_PAPERS_LINK.findall(section)
    if len(paper_links) != len(parsed_rows):
        raise ValueError("AI Papers issue contains unparsed paper links")
    urls = [url for _rank, _title, _description, url in parsed_rows]
    if len(set(urls)) != len(urls):
        raise ValueError("AI Papers issue contains duplicate paper URLs")
    edition_hash = hashlib.sha256(artifact_id.encode("utf-8")).hexdigest()[:12]
    edition_id = f"{issue_date}-papers-{edition_hash}"
    items = tuple(
        FeedItem(
            item_id=(
                "ai-daily:papers:"
                + hashlib.sha256(url.encode("utf-8")).hexdigest()[:24]
            ),
            feed=FeedKind.AI_DAILY,
            edition_id=edition_id,
            title=title,
            body=description,
            url=url,
            published_at=issue_date,
            stream="papers",
            source_id=_AI_PAPERS_SOURCE_ID,
            source_name=_AI_PAPERS_SOURCE_NAME,
            metrics={"rank": rank},
        )
        for rank, title, description, url in parsed_rows
    )
    return FeedEdition(
        edition_id=edition_id,
        feed=FeedKind.AI_DAILY,
        edition_at=issue_date,
        title=issue.group("title").strip(),
        stream="papers",
        items=items,
    )


def ai_daily_markdown_from_v1(
    markdown: str,
    *,
    stream: str,
    source_ids_by_name: Mapping[str, str] | None = None,
) -> FeedEdition:
    """Convert one finalized V1 AI Daily stream Markdown into an edition."""

    if stream not in {"hotspot", "news", "learning"}:
        raise ValueError(f"unsupported AI Daily stream: {stream}")
    issue_date = _frontmatter_value(markdown, "date")
    if not issue_date:
        raise ValueError("AI Daily Markdown has no date")
    title = _frontmatter_value(markdown, "title") or f"AI Daily {issue_date} · {stream}"
    stable_source_ids = {
        name.strip().casefold(): source_id.strip()
        for name, source_id in (source_ids_by_name or {}).items()
        if name.strip() and source_id.strip()
    }
    lines = markdown.splitlines()
    starts: list[tuple[int, re.Match[str], str | None, str | None]] = []
    source_name: str | None = None
    native_section: str | None = None
    for index, line in enumerate(lines):
        match = _AI_ITEM_HEADING.fullmatch(line)
        if match is not None:
            starts.append((index, match, source_name, native_section))
            continue
        heading = _MARKDOWN_HEADING.fullmatch(line)
        if heading is None:
            continue
        level = len(heading.group("marks"))
        if level == 2:
            source_name = _source_heading(heading.group("title"))
            native_section = None
        elif level == 3:
            native_section = heading.group("title").strip() or None
    items: list[FeedItem] = []
    seen_urls: set[str] = set()
    edition_id = f"{issue_date}-{stream}"
    for item_index, (start, match, source_name, native_section) in enumerate(starts):
        end = starts[item_index + 1][0] if item_index + 1 < len(starts) else len(lines)
        body_lines = lines[start + 1 : end]
        item_level = len(match.group("marks") or "")
        section_break = next(
            (
                index
                for index, line in enumerate(body_lines)
                if (heading := _MARKDOWN_HEADING.fullmatch(line)) is not None
                and (item_level == 0 or len(heading.group("marks")) <= item_level)
            ),
            None,
        )
        if section_break is not None:
            body_lines = body_lines[:section_break]
        while body_lines and not body_lines[0].strip():
            body_lines.pop(0)
        while body_lines and not body_lines[-1].strip():
            body_lines.pop()
        published_at: str | None = None
        media: list[str] = []
        rendered_lines: list[str] = []
        for line in body_lines:
            if line.startswith("发布时间："):
                published_at = line.removeprefix("发布时间：").strip() or None
            if line.startswith("图片："):
                for link in _MARKDOWN_LINK.finditer(line):
                    media.append(link.group("url"))
                line = _MARKDOWN_LINK.sub(r"![\g<label>](\g<url>)", line)
            rendered_lines.append(line)
        url = match.group("url")
        if url in seen_urls:
            continue
        seen_urls.add(url)
        stable = hashlib.sha256(url.encode("utf-8")).hexdigest()[:20]
        items.append(
            FeedItem(
                item_id=f"ai-daily:{stream}:{stable}",
                feed=FeedKind.AI_DAILY,
                edition_id=edition_id,
                title=match.group("title"),
                body="\n".join(rendered_lines).strip(),
                url=url,
                published_at=published_at,
                stream=stream,
                source_id=(
                    stable_source_ids.get(source_name.casefold())
                    if source_name is not None
                    else None
                )
                or legacy_source_identity(source_name, url),
                source_name=source_name,
                native_section=native_section,
                media=tuple(dict.fromkeys(media)),
            )
        )
    if not items:
        raise ValueError("AI Daily Markdown has no item headings")
    return FeedEdition(
        edition_id=edition_id,
        feed=FeedKind.AI_DAILY,
        edition_at=issue_date,
        title=title,
        stream=stream,
        items=tuple(items),
    )


def _required_int(value: object, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError(f"{field} must be an integer")
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"{field} must be an integer") from exc


def ai_daily_from_v1(
    issue: Mapping[str, object],
    *,
    content_by_artifact: Mapping[str, str],
) -> list[FeedEdition]:
    issue_date = str(issue["issue_date"])
    streams_value = issue.get("streams")
    if not isinstance(streams_value, list):
        raise ValueError("AI Daily issue has no streams")
    editions: list[FeedEdition] = []
    for stream_object in cast(list[object], streams_value):
        if not isinstance(stream_object, dict):
            continue
        stream = cast(Mapping[str, object], stream_object)
        stream_name = str(stream["stream"])
        channels_value = stream.get("channels", [])
        items: list[FeedItem] = []
        if isinstance(channels_value, list):
            for channel_object in cast(list[object], channels_value):
                if not isinstance(channel_object, dict):
                    continue
                channel = cast(Mapping[str, object], channel_object)
                channel_name = (
                    str(channel["title"]).strip() if channel.get("title") else None
                )
                channel_items = channel.get("items", [])
                if not isinstance(channel_items, list):
                    continue
                for item_object in cast(list[object], channel_items):
                    if not isinstance(item_object, dict):
                        continue
                    item = cast(Mapping[str, object], item_object)
                    artifact_id = str(item["artifact_id"])
                    urls = item.get("source_urls", [])
                    url = (
                        str(cast(list[object], urls)[0])
                        if isinstance(urls, list) and urls
                        else None
                    )
                    source_name = (
                        str(item["source_name"]).strip()
                        if item.get("source_name")
                        else channel_name
                    )
                    source_id = (
                        str(item["source_id"]).strip()
                        if item.get("source_id")
                        else legacy_source_identity(source_name, url)
                    )
                    items.append(
                        FeedItem(
                            item_id=artifact_id,
                            feed=FeedKind.AI_DAILY,
                            edition_id=f"{issue_date}-{stream_name}",
                            title=str(item.get("title") or artifact_id),
                            body=content_by_artifact.get(
                                artifact_id,
                                str(item.get("preview") or ""),
                            ),
                            url=url,
                            published_at=(
                                str(item["generated_at"]) if item.get("generated_at") else None
                            ),
                            stream=stream_name,
                            source_id=source_id,
                            source_name=source_name,
                            native_section=(
                                str(item["section"]).strip() if item.get("section") else None
                            ),
                        )
                    )
        editions.append(
            FeedEdition(
                edition_id=f"{issue_date}-{stream_name}",
                feed=FeedKind.AI_DAILY,
                edition_at=issue_date,
                title=f"AI Daily {issue_date} · {stream_name}",
                stream=stream_name,
                items=tuple(items),
            )
        )
    return editions


def treehole_from_v1(
    batch: Mapping[str, object],
    *,
    comments_by_pid: Mapping[int, tuple[FeedComment | str, ...]] | None = None,
    media_by_pid: Mapping[int, tuple[str, ...]] | None = None,
) -> FeedEdition:
    snapshot_value = batch.get("snapshot")
    snapshot = (
        cast(Mapping[str, object], snapshot_value) if isinstance(snapshot_value, dict) else batch
    )
    snapshot_id = str(snapshot.get("snapshot_id") or snapshot.get("id") or batch.get("event_id"))
    items_value = snapshot.get("items")
    if not isinstance(items_value, list):
        raise ValueError("treehole batch has no items")
    items: list[FeedItem] = []
    for item_object in cast(list[object], items_value):
        if not isinstance(item_object, dict):
            continue
        item = cast(Mapping[str, object], item_object)
        pid = _required_int(item["pid"], field="pid")
        metrics: dict[str, int | float | str] = {}
        for key in ("best_rank", "peak_score"):
            value = item.get(key)
            if isinstance(value, (int, float, str)) and not isinstance(value, bool):
                metrics[key] = value
        aliases = {
            "reply_count": ("reply_count", "peak_reply"),
            # V1 uses ``likenum`` for favorites and ``praise_num`` for likes.
            # Keep the canonical names unambiguous for every downstream view.
            "like_count": ("like_count", "peak_praise_num"),
            "favorite_count": ("favorite_count", "peak_likenum"),
            "captured_comments": ("captured_comments",),
        }
        for target, sources in aliases.items():
            value = next(
                (item.get(source) for source in sources if item.get(source) is not None),
                None,
            )
            if isinstance(value, (int, float, str)) and not isinstance(value, bool):
                metrics[target] = value
        media_value = item.get("post_media", [])
        embedded_media = (
            tuple(
                str(cast(Mapping[str, object], value).get("download_path", ""))
                for value in cast(list[object], media_value)
                if isinstance(value, dict)
            )
            if isinstance(media_value, list)
            else ()
        )
        comments = tuple(
            value if isinstance(value, FeedComment) else FeedComment(text=value)
            for value in (comments_by_pid or {}).get(pid, ())
        )
        if comments and "captured_comments" not in metrics:
            metrics["captured_comments"] = len(comments)
        timestamp = item.get("timestamp")
        published_at = (
            datetime.fromtimestamp(timestamp, UTC).isoformat()
            if isinstance(timestamp, (int, float)) and not isinstance(timestamp, bool)
            else str(timestamp or "")
        )
        items.append(
            FeedItem(
                item_id=f"treehole:{pid}",
                feed=FeedKind.TREEHOLE,
                edition_id=snapshot_id,
                title=f"TreeHole #{pid}",
                body=str(item.get("text") or ""),
                published_at=published_at,
                pid=pid,
                metrics=metrics,
                comments=comments,
                media=(media_by_pid or {}).get(pid, embedded_media),
            )
        )
    return FeedEdition(
        edition_id=snapshot_id,
        feed=FeedKind.TREEHOLE,
        edition_at=str(snapshot["stat_date"]),
        title=f"树洞热榜 {snapshot['stat_date']} {snapshot.get('checkpoint', '')}",
        quality=str(snapshot.get("quality") or ""),
        quality_reason=str(snapshot.get("quality_reason") or "") or None,
        items=tuple(items),
    )
